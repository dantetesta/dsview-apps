package com.dsview.player

import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

/**
 * Loop de sincronização: o coração do modo offline. Espelha o sync.js do app Windows.
 * A cada N min busca o payload REAL; se `version` mudou, baixa a mídia nova, remove a que saiu e
 * grava a "última versão boa". Nunca lança dentro do loop.
 */
class Syncer(
    private val config: Config,
    private val cache: MediaCache,
    private val state: StateStore,
) {
    /** Último status (para o preloader do setup consultar via /dsf/sync-status). */
    @Volatile var lastStatus: JSONObject = JSONObject().put("phase", "idle")
        private set

    @Volatile private var running = false
    @Volatile private var stopFlag = false
    private var thread: Thread? = null

    private fun status(s: JSONObject) { lastStatus = s }

    fun cacheableUrls(payload: JSONObject?): List<String> {
        val out = ArrayList<String>()
        val queue = payload?.optJSONArray("queue") ?: return out
        for (i in 0 until queue.length()) {
            val it = queue.optJSONObject(i) ?: continue
            val provider = it.optString("provider")
            if (provider == "youtube" || provider == "vimeo") continue
            val src = it.optString("src")
            if (src.startsWith("http", ignoreCase = true)) out.add(src)
        }
        return out
    }

    /** Uma passada de sincronização. Não lança; devolve um resumo. */
    fun syncOnce(): JSONObject {
        if (!config.offline) return result(false, "online-only")
        val api = config.realApi() ?: return result(false, "not-configured")
        val url = api + "?t=" + System.currentTimeMillis() +
            if (config.device.isNotEmpty()) "&device=" + enc(config.device) else ""
        val res: JSONObject = try {
            fetchJson(url)
        } catch (e: Exception) {
            status(JSONObject().put("phase", "offline"))
            return result(false, "offline")
        }
        if (res.optString("status") != "ok" || !res.has("payload")) {
            return result(false, res.optString("status", "no-payload"))
        }
        val payload = res.getJSONObject("payload")
        val prev = state.get()
        if (prev != null && prev.optString("version").isNotEmpty() &&
            prev.optString("version") == payload.optString("version")
        ) {
            return JSONObject().put("ok", true).put("changed", false)
        }
        val urls = cacheableUrls(payload)
        var downloaded = 0
        for ((idx, u) in urls.withIndex()) {
            status(JSONObject().put("phase", "downloading").put("current", idx + 1).put("total", urls.size))
            if (cache.has(u)) continue
            try { cache.download(u); downloaded++ } catch (e: Exception) { /* item falho: online ainda toca da origem */ }
        }
        state.set(payload)
        val removed = cache.prune(urls)
        status(JSONObject().put("phase", "ready"))
        return JSONObject().put("ok", true).put("changed", true)
            .put("downloaded", downloaded).put("removed", removed).put("total", urls.size)
    }

    /**
     * Autentica no servidor real (senha, se houver) → guarda o device de sessão eterna + baixa a mídia.
     * Devolve {status} para o setup reagir (ok/password/expired/offline).
     */
    fun authenticate(password: String): JSONObject {
        val api = config.realApi() ?: return JSONObject().put("status", "not-configured")
        val res: JSONObject = try {
            postJson(api + "/auth", JSONObject().put("password", password))
        } catch (e: Exception) {
            val lg = state.get()
            return if (config.device.isNotEmpty() && lg != null)
                JSONObject().put("status", "ok")
            else
                JSONObject().put("status", "offline")
        }
        if (res.optString("status") == "ok") {
            if (res.has("device")) config.device = res.optString("device")
            try { syncOnce() } catch (e: Exception) {}
            return JSONObject().put("status", "ok")
        }
        return res
    }

    fun start() {
        if (thread != null) return
        stopFlag = false
        thread = Thread {
            tick()
            while (!stopFlag) {
                try {
                    Thread.sleep(config.syncInterval.toLong() * 60_000L)
                } catch (e: InterruptedException) {
                    break
                }
                if (stopFlag) break
                tick()
            }
        }.apply { isDaemon = true; name = "dsf-sync"; start() }
    }

    private fun tick() {
        if (running) return
        running = true
        try { syncOnce() } catch (e: Exception) { /* nunca deixa o loop morrer */ }
        running = false
    }

    /** Reaplica o intervalo depois que o usuário o altera no setup. */
    fun restart() { stop(); start() }

    fun stop() {
        stopFlag = true
        thread?.interrupt()
        // `interrupt()` não acorda uma thread bloqueada em I/O de socket (só Thread.sleep) — sem
        // esperar ela sair de verdade, `restart()` (stop+start) largava uma thread órfã ainda
        // rodando com `running=true`, e a thread NOVA via essa flag "true" (é a mesma instância de
        // Syncer) e pulava o primeiro ciclo inteiro — no pior caso, até 24h sem sincronizar depois
        // de trocar o intervalo. O join espera a antiga realmente terminar (limitado pelos timeouts
        // de conexão/leitura abaixo) antes de deixar uma nova começar.
        try { thread?.join(35_000) } catch (e: InterruptedException) { Thread.currentThread().interrupt() }
        thread = null
        running = false // trava de segurança: se o join estourou o prazo, libera mesmo assim.
    }

    private fun result(ok: Boolean, reason: String) = JSONObject().put("ok", ok).put("reason", reason)
    private fun enc(s: String) = URLEncoder.encode(s, "UTF-8")

    private fun fetchJson(url: String): JSONObject {
        val conn = (URL(url).openConnection() as HttpURLConnection).apply {
            instanceFollowRedirects = true
            connectTimeout = 15000
            readTimeout = 20000
            requestMethod = "GET"
        }
        try {
            return JSONObject(readLimited(conn.inputStream))
        } finally {
            conn.disconnect()
        }
    }

    private fun postJson(url: String, body: JSONObject): JSONObject {
        val conn = (URL(url).openConnection() as HttpURLConnection).apply {
            instanceFollowRedirects = true
            connectTimeout = 15000
            readTimeout = 20000
            requestMethod = "POST"
            doOutput = true
            setRequestProperty("Content-Type", "application/json")
        }
        try {
            conn.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
            val stream = if (conn.responseCode in 200..299) conn.inputStream else conn.errorStream
            return JSONObject(readLimited(stream))
        } finally {
            conn.disconnect()
        }
    }
}

// Um payload de playlist real não passa de alguns KB — sem limite, um servidor comprometido ou
// mal configurado devolvendo uma resposta gigante estoura a memória com OutOfMemoryError, que
// (sendo Error, não Exception) escapa de todo catch (e: Exception) por aqui e derruba o app inteiro.
internal const val MAX_RESPONSE_BYTES = 5 * 1024 * 1024 // 5 MB — folga generosa sobre o que uma playlist real usa.

internal fun readLimited(stream: java.io.InputStream, maxBytes: Int = MAX_RESPONSE_BYTES): String {
    val buffer = java.io.ByteArrayOutputStream()
    val chunk = ByteArray(8192)
    var total = 0
    stream.use {
        while (true) {
            val n = it.read(chunk)
            if (n < 0) break
            total += n
            if (total > maxBytes) throw java.io.IOException("Resposta maior que $maxBytes bytes")
            buffer.write(chunk, 0, n)
        }
    }
    return buffer.toString("UTF-8")
}
