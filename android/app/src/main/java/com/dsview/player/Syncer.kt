package com.dsview.player

import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import kotlin.random.Random
import java.util.concurrent.Callable
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger

/**
 * Loop de sincronização: o coração do modo offline. Espelha o sync.js do app Windows.
 * A cada N min busca o payload REAL; se `version` mudou, baixa a mídia nova, remove a que saiu e
 * grava a "última versão boa". Nunca lança dentro do loop.
 */
class Syncer(
    private val config: Config,
    private val cache: MediaCache,
    private val state: StateStore,
    private val appVersion: String,
) {
    /** Último status (para o preloader do setup consultar via /dsf/sync-status). */
    @Volatile var lastStatus: JSONObject = JSONObject().put("phase", "idle")
        private set

    @Volatile private var stopFlag = false
    @Volatile private var loopGeneration = 0L
    private var thread: Thread? = null
    private var heartbeatThread: Thread? = null
    @Volatile private var lastSyncAt = ""
    @Volatile private var healthOverride = ""
    @Volatile private var healthError = ""
    private val syncLock = Any()
    private val sessionLock = Any()
    @Volatile private var generation = 0L

    private fun status(s: JSONObject) { lastStatus = s }

    fun cacheableUrls(payload: JSONObject?): List<String> {
        val out = linkedMapOf<String, Boolean>()
        val queue = payload?.optJSONArray("queue") ?: return emptyList()
        for (i in 0 until queue.length()) {
            val it = queue.optJSONObject(i) ?: continue
            val provider = it.optString("provider")
            if (provider == "youtube" || provider == "vimeo") continue
            for (key in listOf("src", "fallback_src", "source_logo")) {
                val url = it.optString(key)
                if (url.startsWith("http://", true) || url.startsWith("https://", true)) {
                    val video = key == "src" && (it.optString("kind") == "video" ||
                        Regex("\\.(mp4|webm|mov|m4v|mkv)(?:[?#]|$)", RegexOption.IGNORE_CASE).containsMatchIn(url))
                    out[url] = (out[url] ?: true) && video
                }
            }
        }
        return out.entries.sortedBy { it.value }.map { it.key }
    }

    /** Uma passada de sincronização. Não lança; devolve um resumo. */
    fun syncOnce(): JSONObject = synchronized(syncLock) { syncLocked() }

    private fun syncLocked(): JSONObject {
        if (!config.offline) return result(false, "online-only")
        val (epoch, api) = synchronized(sessionLock) {
            generation to (config.realApi() ?: return result(false, "not-configured"))
        }
        fun stale() = epoch != generation || api != config.realApi() || !config.offline
        val url = api + "?t=" + System.currentTimeMillis() +
            if (config.device.isNotEmpty()) "&device=" + enc(config.device) else ""
        val res: JSONObject = try {
            fetchJson(url)
        } catch (e: Exception) {
            if (!stale()) status(JSONObject().put("phase", "offline"))
            return result(false, "offline")
        }
        if (res.optString("status") != "ok" || !res.has("payload")) {
            return result(false, res.optString("status", "no-payload"))
        }
        val payload = res.getJSONObject("payload")
        if (stale()) return result(false, "superseded")
        lastSyncAt = isoNow()
        val prev = state.get()
        val changed = prev == null || prev.optString("version").isEmpty() || prev.optString("version") != payload.optString("version")
        val urls = cacheableUrls(payload)
        val missing = urls.filterNot { cache.isVerified(it) }
        val completed = AtomicInteger(urls.size - missing.size)
        val downloaded = downloadInParallel(missing, cancelled = ::stale) { u ->
            try { retryMediaDownload(::stale) { cache.download(u, ::stale) } } finally {
                val count = completed.incrementAndGet()
                synchronized(sessionLock) {
                    if (!stale()) status(JSONObject().put("phase", "downloading").put("current", count).put("total", urls.size))
                }
            }
        }
        synchronized(sessionLock) {
            if (stale()) return result(false, "superseded")
            val failed = urls.count { !cache.isVerified(it) }
            if (failed > 0) {
                status(JSONObject().put("phase", "partial").put("failed", failed).put("total", urls.size))
                return result(false, "incomplete").put("failed", failed).put("downloaded", downloaded)
            }
            state.set(payload)
            val removed = cache.prune(urls)
            status(JSONObject().put("phase", "ready"))
            return JSONObject().put("ok", true).put("changed", changed)
                .put("downloaded", downloaded).put("removed", removed).put("total", urls.size)
        }
    }

    /** Invalidates in-flight work before changing playlist or deleting its cache. */
    fun changePlaylist(origin: String, token: String, input: String) = synchronized(sessionLock) {
        val changed = config.origin != origin || config.token != token
        generation++
        cache.invalidateDownloads()
        config.origin = origin
        config.token = token
        config.lastUrl = input
        if (changed) { config.device = ""; state.clear() }
        status(JSONObject().put("phase", "idle"))
    }

    fun clearCache(): Int = synchronized(sessionLock) {
        generation++
        val removed = cache.clear()
        state.clear()
        status(JSONObject().put("phase", "idle"))
        removed
    }

    fun setOffline(on: Boolean) = synchronized(sessionLock) {
        if (config.offline != on) { generation++; cache.invalidateDownloads() }
        config.offline = on
    }

    /**
     * Autentica no servidor real (senha, se houver) → guarda o device de sessão eterna + baixa a mídia.
     * Devolve {status} para o setup reagir (ok/password/expired/offline).
     */
    fun authenticate(password: String): JSONObject {
        val api = config.realApi() ?: return JSONObject().put("status", "not-configured")
        val epoch = generation
        val res: JSONObject = try {
            postJson(api + "/auth", telemetry().put("password", password))
        } catch (e: Exception) {
            if (epoch != generation || api != config.realApi()) return JSONObject().put("status", "superseded")
            val lg = state.get()
            return if (config.device.isNotEmpty() && lg != null)
                JSONObject().put("status", "ok")
            else
                JSONObject().put("status", "offline")
        }
        if (res.optString("status") == "ok") {
            synchronized(sessionLock) {
                if (epoch != generation || api != config.realApi()) return JSONObject().put("status", "superseded")
                if (res.has("device")) config.device = res.optString("device")
            }
            try { syncOnce() } catch (e: Exception) {}
            synchronized(sessionLock) {
                if (epoch != generation || api != config.realApi()) return JSONObject().put("status", "superseded")
                if (state.get() == null && config.offline) return JSONObject().put("status", "offline")
                return JSONObject().put("status", "ok")
            }
        }
        return res
    }

    fun start() {
        if (thread != null) return
        stopFlag = false
        val loop = ++loopGeneration
        thread = Thread {
            tick()
            while (!stopFlag && loop == loopGeneration) {
                try {
                    Thread.sleep(config.syncInterval.toLong() * 60_000L)
                } catch (e: InterruptedException) {
                    break
                }
                if (stopFlag || loop != loopGeneration) break
                tick()
            }
        }.apply { isDaemon = true; name = "dsf-sync"; start() }
        heartbeatThread = Thread {
            heartbeatOnce()
            while (!stopFlag && loop == loopGeneration) {
                val waitMs = heartbeatDelay(Random.nextDouble())
                try { Thread.sleep(waitMs) } catch (e: InterruptedException) { break }
                if (!stopFlag && loop == loopGeneration) heartbeatOnce()
            }
        }.apply { isDaemon = true; name = "dsf-heartbeat"; start() }
    }

    private fun tick() {
        try { syncOnce() } catch (e: Exception) { /* nunca deixa o loop morrer */ }
    }

    /** Reaplica o intervalo depois que o usuário o altera no setup. */
    fun restart() { stop(); start() }

    fun stop() {
        stopFlag = true
        loopGeneration++
        synchronized(sessionLock) { generation++; cache.invalidateDownloads() }
        thread?.interrupt()
        heartbeatThread?.interrupt()
        // Socket I/O may outlive interrupt/join. Generation tokens stop the old loop from
        // restarting after start() clears stopFlag; syncLock prevents overlapping sync commits.
        try { thread?.join(35_000) } catch (e: InterruptedException) { Thread.currentThread().interrupt() }
        try { heartbeatThread?.join(5_000) } catch (e: InterruptedException) { Thread.currentThread().interrupt() }
        thread = null
        heartbeatThread = null
    }

    /** MainActivity informa falha/recuperação do WebView sem acoplar rede à UI. */
    fun setHealth(health: String, error: String = "") {
        healthOverride = if (health == "degraded") "degraded" else ""
        healthError = if (healthOverride.isNotEmpty()) error.take(255) else ""
    }

    /** Fotografia pequena, sem URL, senha ou conteúdo da playlist. */
    internal fun telemetry(): JSONObject {
        val health = if (healthOverride.isNotEmpty()) healthOverride else "healthy"
        return JSONObject()
            .put("platform", "android")
            .put("app_version", appVersion)
            .put("mode", if (config.offline) "offline_cache" else "online")
            .put("health", health)
            .put("last_error", if (health == "degraded") healthError else "")
            .put("last_sync_at", lastSyncAt)
    }

    /** Heartbeat independente da sincronização. Falhar sem internet é esperado e silencioso. */
    internal fun heartbeatOnce(): JSONObject {
        val api = config.realApi() ?: return result(false, "not-configured")
        if (config.device.isEmpty()) return result(false, "not-authenticated")
        return try {
            val res = postJson(api + "/heartbeat", telemetry().put("device", config.device))
            JSONObject().put("ok", res.optString("status") == "ok")
        } catch (e: Exception) {
            result(false, "offline")
        }
    }

    private fun result(ok: Boolean, reason: String) = JSONObject().put("ok", ok).put("reason", reason)
    private fun enc(s: String) = URLEncoder.encode(s, "UTF-8")

    private fun isoNow(): String = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US).apply {
        timeZone = TimeZone.getTimeZone("UTC")
    }.format(Date())

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
internal const val HEARTBEAT_MS = 60_000L
internal const val HEARTBEAT_JITTER_MS = 15_000L

internal fun retryMediaDownload(cancelled: () -> Boolean, download: () -> Unit) {
    repeat(3) { attempt ->
        if (cancelled() || Thread.currentThread().isInterrupted) throw java.io.IOException("Download cancelado")
        try { download(); return } catch (e: java.io.IOException) {
            if (attempt == 2 || cancelled()) throw e
            Thread.sleep(250L * (attempt + 1))
        }
    }
}

/** Fixed worker count bounds sockets/memory; input order gives small images first access. */
internal fun downloadInParallel(
    urls: List<String>,
    cancelled: () -> Boolean = { false },
    download: (String) -> Unit,
): Int {
    if (urls.isEmpty()) return 0
    val pool = Executors.newFixedThreadPool(minOf(3, urls.size))
    return try {
        val jobs = urls.map { url -> pool.submit(Callable {
            if (cancelled()) false else try { download(url); true } catch (e: Exception) { false }
        }) }
        jobs.count { it.get() }
    } finally {
        pool.shutdownNow()
        // No worker may publish into a later sync/prune cycle after interruption.
        var interrupted = Thread.interrupted()
        while (!pool.isTerminated) {
            try { pool.awaitTermination(1, java.util.concurrent.TimeUnit.SECONDS) }
            catch (e: InterruptedException) { interrupted = true }
        }
        if (interrupted) Thread.currentThread().interrupt()
    }
}

internal fun heartbeatDelay(randomUnit: Double): Long =
    HEARTBEAT_MS + (randomUnit.coerceIn(0.0, 1.0) * HEARTBEAT_JITTER_MS).toLong()

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
