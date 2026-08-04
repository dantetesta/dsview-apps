package com.dsview.player

import java.net.HttpURLConnection
import java.net.URL

/**
 * Resolve o que o usuário cola no setup → (origin, token). Espelha o resolve.js do app Windows.
 * Aceita link /play/{token}, código curto (segue 302), ou código + origin conhecido.
 */
object Resolver {
    data class Resolved(val origin: String, val token: String)

    private val PLAY = Regex("/play/([A-Za-z0-9]+)/?$")

    fun parsePlayUrl(u: String): Resolved? = try {
        val url = URL(u)
        val m = PLAY.find(url.path)
        if (m != null) Resolved(url.protocol + "://" + url.authority, m.groupValues[1]) else null
    } catch (e: Exception) { null }

    fun resolve(input: String, knownOrigin: String): Resolved {
        val trimmed = input.trim()
        parsePlayUrl(trimmed)?.let { return it }

        var base = knownOrigin
        var codePath = trimmed
        val parsed = try { URL(trimmed) } catch (e: Exception) { null }
        if (parsed != null) {
            base = parsed.protocol + "://" + parsed.authority
            codePath = parsed.toString()
        } else {
            if (base.isEmpty()) throw RuntimeException("Cole o link completo da playlist (ex.: https://site/play/xxxx).")
            codePath = base.trimEnd('/') + "/" + trimmed.replace(Regex("\\D"), "")
        }
        val finalU = finalUrl(codePath)
        parsePlayUrl(finalU)?.let { return it }
        throw RuntimeException("Não consegui resolver essa URL/código. Confira e tente de novo.")
    }

    /** Segue redirects (até 5) e devolve a URL final. */
    private fun finalUrl(u: String): String {
        var current = u
        var hops = 0
        while (hops < 5) {
            val conn = (URL(current).openConnection() as HttpURLConnection).apply {
                instanceFollowRedirects = false
                connectTimeout = 15000
                readTimeout = 15000
                requestMethod = "GET"
            }
            try {
                val code = conn.responseCode
                if (code in 300..399) {
                    val loc = conn.getHeaderField("Location") ?: return current
                    current = if (loc.startsWith("http")) loc else URL(URL(current), loc).toString()
                    hops++
                    continue
                }
                return current
            } finally {
                conn.disconnect()
            }
        }
        return current
    }
}
