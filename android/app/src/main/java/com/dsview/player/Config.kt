package com.dsview.player

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.net.URLEncoder

/**
 * Config persistente (SharedPreferences). Espelha o config.js do app Windows.
 * origin/token da playlist ativa, device (sessão eterna do /auth), favoritos, e preferências.
 */
class Config(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences("dsview", Context.MODE_PRIVATE)

    var origin: String
        get() = prefs.getString("origin", "") ?: ""
        set(v) { prefs.edit().putString("origin", v).apply() }

    var token: String
        get() = prefs.getString("token", "") ?: ""
        set(v) { prefs.edit().putString("token", v).apply() }

    var device: String
        get() = prefs.getString("device", "") ?: ""
        set(v) { prefs.edit().putString("device", v).apply() }

    var autostart: Boolean
        get() = prefs.getBoolean("autostart", false)
        set(v) { prefs.edit().putBoolean("autostart", v).apply() }

    /** Offline-first (cache local) ligado por padrão. false = consome só o servidor online. */
    var offline: Boolean
        get() = prefs.getBoolean("offline", true)
        set(v) { prefs.edit().putBoolean("offline", v).apply() }

    /** Resultado da última tentativa de abrir no boot (aparece no Diagnóstico). */
    var lastBootLaunch: String
        get() = prefs.getString("lastBootLaunch", "") ?: ""
        set(v) { prefs.edit().putString("lastBootLaunch", v).apply() }

    var lastUrl: String
        get() = prefs.getString("lastUrl", "") ?: ""
        set(v) { prefs.edit().putString("lastUrl", v).apply() }

    /** Minutos entre consultas à playlist (5..1440). */
    var syncInterval: Int
        get() = prefs.getInt("syncInterval", SYNC_DEFAULT).coerceIn(SYNC_MIN, SYNC_MAX)
        set(v) { prefs.edit().putInt("syncInterval", v.coerceIn(SYNC_MIN, SYNC_MAX)).apply() }

    var favorites: JSONArray
        get() = try { JSONArray(prefs.getString("favorites", "[]")) } catch (e: Exception) { JSONArray() }
        set(v) { prefs.edit().putString("favorites", v.toString()).apply() }

    val isConfigured: Boolean get() = origin.isNotEmpty() && token.isNotEmpty()

    /** Base REST da API do player para a playlist ativa (null se não configurada). */
    fun realApi(): String? {
        if (!isConfigured) return null
        return origin.trimEnd('/') + "/wp-json/ds-facil/v1/player/" + URLEncoder.encode(token, "UTF-8")
    }

    fun addFavorite(name: String, url: String) {
        val favs = favorites
        val out = JSONArray()
        out.put(JSONObject().put("name", name.ifEmpty { url }).put("url", url))
        for (i in 0 until favs.length()) {
            val f = favs.optJSONObject(i) ?: continue
            if (f.optString("url") != url && out.length() < 30) out.put(f)
        }
        favorites = out
    }

    fun removeFavorite(url: String) {
        val favs = favorites
        val out = JSONArray()
        for (i in 0 until favs.length()) {
            val f = favs.optJSONObject(i) ?: continue
            if (f.optString("url") != url) out.put(f)
        }
        favorites = out
    }

    fun toJson(): JSONObject = JSONObject()
        .put("origin", origin).put("token", token).put("device", device)
        .put("favorites", favorites).put("autostart", autostart)
        .put("offline", offline).put("syncInterval", syncInterval).put("lastUrl", lastUrl)
        .put("lastBootLaunch", lastBootLaunch)

    companion object {
        const val SYNC_MIN = 5
        const val SYNC_MAX = 1440
        const val SYNC_DEFAULT = 60
    }
}
