package com.dsview.player

import android.content.Context
import android.os.SystemClock
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

    /**
     * Domínio do sistema, configurado uma vez em Configurações (ex.: "suaempresa.com.br"). Com ele
     * definido, a aba Básico aceita só o código da playlist em vez do link completo. Independente do
     * `origin` (que é o domínio da playlist ATIVA) — permite trocar de playlist sem perder o domínio.
     */
    var baseDomain: String
        get() = prefs.getString("baseDomain", "") ?: ""
        set(v) { prefs.edit().putString("baseDomain", normalizeDomain(v)).apply() }

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

    /**
     * Boot-id (ver `bootId()`) em que o usuário fechou o app de propósito (menu "Sair"). Enquanto
     * for o boot atual, `MainActivity` recusa abrir sozinho — nem se o app for a tela inicial do
     * aparelho e o Android tentar reabrir por ser HOME. Só um boot novo libera de novo.
     */
    var quitUntilBoot: Long
        get() = prefs.getLong("quitUntilBoot", 0L)
        set(v) { prefs.edit().putLong("quitUntilBoot", v).apply() }

    /** Minutos entre consultas à playlist (5..1440). */
    var syncInterval: Int
        get() = clampInterval(prefs.getInt("syncInterval", SYNC_DEFAULT))
        set(v) { prefs.edit().putInt("syncInterval", clampInterval(v)).apply() }

    var favorites: JSONArray
        get() = try { JSONArray(prefs.getString("favorites", "[]")) } catch (e: Exception) { JSONArray() }
        set(v) { prefs.edit().putString("favorites", v.toString()).apply() }

    val isConfigured: Boolean get() = origin.isNotEmpty() && token.isNotEmpty()

    /** Base REST da API do player para a playlist ativa (null se não configurada). */
    fun realApi(): String? = buildRealApi(origin, token)

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
        .put("lastBootLaunch", lastBootLaunch).put("baseDomain", baseDomain)

    companion object {
        const val SYNC_MIN = 5
        const val SYNC_MAX = 1440
        const val SYNC_DEFAULT = 60

        /**
         * Fingerprint estável do boot atual (epoch-ms de quando o aparelho ligou). `elapsedRealtime()`
         * anda junto com `currentTimeMillis()`, então a subtração dá sempre o mesmo instante, boot
         * afora — sem precisar de nenhuma permissão extra. Mesmo truque do app Windows (`os.uptime()`).
         */
        fun bootId(): Long = System.currentTimeMillis() - SystemClock.elapsedRealtime()

        /** Clampa o intervalo de sync em SYNC_MIN..SYNC_MAX. Pura — testável sem Context. */
        fun clampInterval(v: Int): Int = v.coerceIn(SYNC_MIN, SYNC_MAX)

        /** Monta a rota REST do player, ou null se origin/token estiverem vazios. Pura — testável sem Context. */
        fun buildRealApi(origin: String, token: String): String? {
            if (origin.isEmpty() || token.isEmpty()) return null
            return origin.trimEnd('/') + "/wp-json/ds-facil/v1/player/" + URLEncoder.encode(token, "UTF-8")
        }

        /**
         * Normaliza o que o usuário digitar em "Domínio do sistema" ("dsview.com.br",
         * "https://dsview.com.br/", "dsview.com.br:8080"...) para um origin limpo
         * ("https://dsview.com.br"), ou "" se não der pra interpretar como domínio/URL.
         * Pura — testável sem Context.
         */
        fun normalizeDomain(input: String): String {
            val t = input.trim()
            if (t.isEmpty()) return ""
            val withScheme = if (Regex("^https?://", RegexOption.IGNORE_CASE).containsMatchIn(t)) t else "https://$t"
            return try {
                val u = java.net.URL(withScheme)
                if (u.host.isNullOrEmpty()) "" else u.protocol + "://" + u.authority
            } catch (e: Exception) { "" }
        }
    }
}
