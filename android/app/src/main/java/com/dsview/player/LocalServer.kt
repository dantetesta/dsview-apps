package com.dsview.player

import android.content.Context
import android.content.Intent
import fi.iki.elonen.NanoHTTPD
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.net.HttpURLConnection
import java.net.URL

/**
 * Servidor HTTP local (só 127.0.0.1, porta alta aleatória). Imita a forma da API do player para o
 * player.js rodar IDÊNTICO ao do site, e serve o setup + os endpoints /dsf/… do app.
 * Espelha o server.js do app Windows.
 *
 *   GET  /state[?t=&device=]  → última versão boa (reescrita p/ /media/{hash} quando cacheada)
 *   POST /state/auth          → repassa pro servidor real; guarda device; cacheia; devolve ao player
 *   GET  /media/:name         → arquivo do disco (com Range → 206, essencial p/ vídeo)
 *   GET  /setup /player /assets/… → páginas e assets do app
 *   /dsf/…                    → API do setup (config, resolve, authenticate, sync, favoritos, etc.)
 */
class LocalServer(
    private val context: Context,
    private val config: Config,
    private val cache: MediaCache,
    private val state: StateStore,
    private val syncer: Syncer,
) : NanoHTTPD("127.0.0.1", 0) {

    private val mediaName = Regex("^[a-f0-9]{40}\\.[a-z0-9]{1,5}$")

    override fun serve(session: IHTTPSession): Response {
        val uri = session.uri
        val method = session.method
        return try {
            when {
                method == Method.OPTIONS -> cors(newFixedLengthResponse(Response.Status.NO_CONTENT, MIME_PLAINTEXT, ""))
                uri == "/state" && method == Method.GET -> serveState()
                uri == "/state/auth" && method == Method.POST -> proxyAuth(session)
                uri.startsWith("/media/") && method == Method.GET -> serveMedia(session, uri.removePrefix("/media/"))
                uri == "/setup" || uri == "/" -> asset("setup.html", "text/html")
                uri == "/player" -> asset("player.html", "text/html")
                uri.startsWith("/assets/") -> asset(uri.removePrefix("/assets/"), null)
                uri.startsWith("/dsf/") -> dsf(session, uri.removePrefix("/dsf/"))
                else -> newFixedLengthResponse(Response.Status.NOT_FOUND, MIME_PLAINTEXT, "not found")
            }
        } catch (e: Exception) {
            newFixedLengthResponse(Response.Status.INTERNAL_ERROR, MIME_PLAINTEXT, e.message ?: "error")
        }
    }

    // ---------------------------------------------------------------- player API
    private fun serveState(): Response {
        val lg = state.get()
        val body = if (lg != null)
            JSONObject().put("status", "ok").put("payload", rewrite(lg))
        else
            JSONObject().put("status", "offline")
        return json(body)
    }

    private fun proxyAuth(session: IHTTPSession): Response {
        val api = config.realApi() ?: return json(JSONObject().put("status", "offline"))
        val files = HashMap<String, String>()
        session.parseBody(files)
        val bodyStr = files["postData"] ?: "{}"
        val res: JSONObject = try {
            postJson(api + "/auth", bodyStr)
        } catch (e: Exception) {
            val lg = state.get()
            return json(
                if (config.device.isNotEmpty() && lg != null)
                    JSONObject().put("status", "ok").put("device", config.device).put("payload", rewrite(lg))
                else JSONObject().put("status", "offline")
            )
        }
        if (res.optString("status") == "ok") {
            if (res.has("device")) config.device = res.optString("device")
            if (res.has("payload")) {
                val p = res.getJSONObject("payload")
                state.set(p)
                Thread { try { syncer.syncOnce() } catch (e: Exception) {} }.start()
                res.put("payload", rewrite(p))
            }
        }
        return json(res)
    }

    private fun serveMedia(session: IHTTPSession, name: String): Response {
        if (!mediaName.matches(name)) return newFixedLengthResponse(Response.Status.BAD_REQUEST, MIME_PLAINTEXT, "")
        val file = File(cache.dir(), name)
        if (!file.exists()) return newFixedLengthResponse(Response.Status.NOT_FOUND, MIME_PLAINTEXT, "")
        val type = mimeOf(name)
        val len = file.length()
        val range = session.headers["range"]
        if (range != null) {
            val m = Regex("bytes=(\\d*)-(\\d*)").find(range)
            var start = m?.groupValues?.get(1)?.toLongOrNull() ?: 0L
            var end = m?.groupValues?.get(2)?.toLongOrNull() ?: (len - 1)
            if (start < 0) start = 0
            if (end >= len) end = len - 1
            if (start > end) {
                val r = newFixedLengthResponse(Response.Status.RANGE_NOT_SATISFIABLE, MIME_PLAINTEXT, "")
                r.addHeader("Content-Range", "bytes */$len")
                return cors(r)
            }
            val contentLength = end - start + 1
            val fis = FileInputStream(file)
            var skipped = 0L
            while (skipped < start) { val s = fis.skip(start - skipped); if (s <= 0) break; skipped += s }
            val r = newFixedLengthResponse(Response.Status.PARTIAL_CONTENT, type, fis, contentLength)
            r.addHeader("Content-Range", "bytes $start-$end/$len")
            r.addHeader("Accept-Ranges", "bytes")
            return cors(r)
        }
        val r = newFixedLengthResponse(Response.Status.OK, type, FileInputStream(file), len)
        r.addHeader("Accept-Ranges", "bytes")
        return cors(r)
    }

    /** Reescreve os src das mídias cacheadas para o servidor local (YouTube/Vimeo/não-cacheado ficam como estão). */
    private fun rewrite(payload: JSONObject?): JSONObject? {
        if (payload == null) return null
        val copy = JSONObject(payload.toString())
        val queue = copy.optJSONArray("queue") ?: return copy
        for (i in 0 until queue.length()) {
            val it = queue.optJSONObject(i) ?: continue
            val provider = it.optString("provider")
            if (provider == "youtube" || provider == "vimeo") continue
            val src = it.optString("src")
            if (src.isNotEmpty() && cache.has(src)) {
                it.put("src", "http://127.0.0.1:$listeningPort/media/" + cache.fileName(src))
            }
        }
        return copy
    }

    // ---------------------------------------------------------------- setup API (/dsf/*)
    private fun dsf(session: IHTTPSession, path: String): Response {
        val files = HashMap<String, String>()
        if (session.method == Method.POST) session.parseBody(files)
        val body = try { JSONObject(files["postData"] ?: "{}") } catch (e: Exception) { JSONObject() }

        return when (path) {
            "config" -> json(config.toJson())
            "sync-status" -> json(syncer.lastStatus)
            "favorites" -> {
                if (session.method == Method.POST) {
                    config.addFavorite(body.optString("name"), body.optString("url"))
                }
                json(JSONObject().put("favorites", config.favorites))
            }
            "favorites/remove" -> {
                config.removeFavorite(body.optString("url"))
                json(JSONObject().put("favorites", config.favorites))
            }
            "resolve" -> {
                try {
                    val r = Resolver.resolve(body.optString("input"), config.origin)
                    // Troca de playlist zera o device.
                    config.origin = r.origin
                    config.token = r.token
                    config.device = ""
                    config.lastUrl = body.optString("input")
                    json(JSONObject().put("ok", true).put("origin", r.origin).put("token", r.token))
                } catch (e: Exception) {
                    json(JSONObject().put("ok", false).put("error", e.message ?: "Falha ao resolver a URL."))
                }
            }
            "authenticate" -> json(syncer.authenticate(body.optString("password")))
            "sync" -> json(syncer.syncOnce())
            "offline" -> { config.offline = body.optBoolean("on", true); json(JSONObject().put("offline", config.offline)) }
            "interval" -> {
                config.syncInterval = body.optInt("minutes", Config.SYNC_DEFAULT)
                syncer.restart()
                json(JSONObject().put("interval", config.syncInterval))
            }
            "autostart" -> { config.autostart = body.optBoolean("on", false); json(JSONObject().put("autostart", config.autostart)) }
            // Estado real do auto-start: ligar o interruptor não basta no Android 10+.
            "autostart-status" -> json(
                JSONObject()
                    .put("autostart", config.autostart)
                    .put("overlay", canDrawOverlays())
                    .put("isHome", isDefaultHome())
                    .put("sdk", android.os.Build.VERSION.SDK_INT)
                    .put("precisaOverlay", android.os.Build.VERSION.SDK_INT >= 29 && !canDrawOverlays() && !isDefaultHome())
                    .put("ultimoBoot", config.lastBootLaunch)
            )
            // Abre a tela do sistema onde a permissão é concedida (não dá para conceder por código).
            "autostart-permitir" -> { abrirTelaSistema(android.provider.Settings.ACTION_MANAGE_OVERLAY_PERMISSION, true); json(JSONObject().put("ok", true)) }
            // Abre a escolha de tela inicial do aparelho (caminho mais garantido em TV Box).
            "autostart-home" -> { abrirTelaSistema(android.provider.Settings.ACTION_HOME_SETTINGS, false); json(JSONObject().put("ok", true)) }
            "clear" -> {
                val removed = cache.clear()
                state.clear()
                val res = try { syncer.syncOnce() } catch (e: Exception) { JSONObject().put("ok", false) }
                json(JSONObject().put("removed", removed).put("resync", res))
            }
            else -> newFixedLengthResponse(Response.Status.NOT_FOUND, MIME_PLAINTEXT, "not found")
        }
    }

    // ---------------------------------------------------------------- auto-start
    private fun canDrawOverlays(): Boolean =
        android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.M ||
            android.provider.Settings.canDrawOverlays(context)

    /** Este app é a tela inicial do aparelho? (aí o boot abre ele sozinho, sem depender de nada.) */
    private fun isDefaultHome(): Boolean = try {
        val i = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME)
        val r = context.packageManager.resolveActivity(i, android.content.pm.PackageManager.MATCH_DEFAULT_ONLY)
        r?.activityInfo?.packageName == context.packageName
    } catch (e: Exception) {
        false
    }

    /**
     * Abre uma tela de configuração do sistema. `comPacote` manda o usuário direto para a linha
     * deste app (na permissão de sobreposição), o que evita ele se perder numa lista enorme.
     */
    private fun abrirTelaSistema(acao: String, comPacote: Boolean) {
        try {
            val i = Intent(acao)
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            if (comPacote) i.data = android.net.Uri.parse("package:" + context.packageName)
            context.startActivity(i)
        } catch (e: Exception) {
            try {
                context.startActivity(Intent(android.provider.Settings.ACTION_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            } catch (e2: Exception) { /* ROM sem a tela: o texto do setup explica o caminho manual */ }
        }
    }

    // ---------------------------------------------------------------- helpers
    private fun asset(name: String, mimeOverride: String?): Response {
        return try {
            val bytes = context.assets.open(name).use { it.readBytes() }
            val mime = mimeOverride ?: mimeOf(name)
            cors(newFixedLengthResponse(Response.Status.OK, mime, bytes.inputStream(), bytes.size.toLong()))
        } catch (e: Exception) {
            newFixedLengthResponse(Response.Status.NOT_FOUND, MIME_PLAINTEXT, "asset not found")
        }
    }

    private fun json(obj: JSONObject): Response {
        val r = newFixedLengthResponse(Response.Status.OK, "application/json", obj.toString())
        r.addHeader("Cache-Control", "no-store")
        return cors(r)
    }

    private fun cors(r: Response): Response {
        r.addHeader("Access-Control-Allow-Origin", "*")
        r.addHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        r.addHeader("Access-Control-Allow-Headers", "Content-Type")
        return r
    }

    private fun postJson(url: String, body: String): JSONObject {
        val conn = (URL(url).openConnection() as HttpURLConnection).apply {
            instanceFollowRedirects = true
            connectTimeout = 15000
            readTimeout = 20000
            requestMethod = "POST"
            doOutput = true
            setRequestProperty("Content-Type", "application/json")
        }
        try {
            conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            val stream = if (conn.responseCode in 200..299) conn.inputStream else conn.errorStream
            return JSONObject(stream.bufferedReader().use { it.readText() })
        } finally {
            conn.disconnect()
        }
    }

    private fun mimeOf(name: String): String = when (name.substringAfterLast('.').lowercase()) {
        "html" -> "text/html"
        "css" -> "text/css"
        "js" -> "application/javascript"
        "json" -> "application/json"
        "mp4" -> "video/mp4"
        "webm" -> "video/webm"
        "mov" -> "video/quicktime"
        "webp" -> "image/webp"
        "jpg", "jpeg" -> "image/jpeg"
        "png" -> "image/png"
        "gif" -> "image/gif"
        else -> "application/octet-stream"
    }
}
