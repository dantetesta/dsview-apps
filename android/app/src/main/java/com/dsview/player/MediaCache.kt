package com.dsview.player

import android.content.Context
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/**
 * Cache de mídia local (espelho do conteúdo online no disco). Espelha o cache.js do app Windows.
 * Nome do arquivo = sha1(url)+ext (determinístico). Download ATÔMICO: baixa para .part e só renomeia no fim.
 */
class MediaCache(context: Context) {
    private val dir = File(context.applicationContext.filesDir, "media").apply { mkdirs() }

    fun dir(): File = dir
    fun fileName(url: String): String = sha1(url) + extOf(url)
    fun filePath(url: String): File = File(dir, fileName(url))
    fun has(url: String): Boolean = filePath(url).let { it.exists() && it.length() > 0 }

    /** Baixa a URL para o disco (atômico). Lança em erro/HTTP != 200. */
    fun download(url: String) {
        val dst = filePath(url)
        val part = File(dst.absolutePath + ".part")
        val conn = (URL(url).openConnection() as HttpURLConnection).apply {
            instanceFollowRedirects = true
            connectTimeout = 15000
            readTimeout = 60000
        }
        try {
            if (conn.responseCode != 200) throw RuntimeException("HTTP ${conn.responseCode} ao baixar $url")
            conn.inputStream.use { input -> part.outputStream().use { out -> input.copyTo(out) } }
            if (!part.renameTo(dst)) {
                part.copyTo(dst, overwrite = true)
                part.delete()
            }
        } catch (e: Exception) {
            part.delete()
            throw e
        } finally {
            conn.disconnect()
        }
    }

    /** Remove os arquivos que não estão mais no conjunto de URLs em uso. */
    fun prune(keepUrls: List<String>): Int {
        val keep = keepUrls.map { fileName(it) }.toHashSet()
        var removed = 0
        dir.listFiles()?.forEach { f ->
            if (f.name.endsWith(".part")) { f.delete(); return@forEach }
            if (!keep.contains(f.name)) { if (f.delete()) removed++ }
        }
        return removed
    }

    /** Apaga toda a mídia local (reset do cache). */
    fun clear(): Int {
        var removed = 0
        dir.listFiles()?.forEach { if (it.delete()) removed++ }
        return removed
    }

    private fun extOf(url: String): String = try {
        val path = URL(url).path
        val m = Regex("\\.([a-zA-Z0-9]{1,5})$").find(path)
        if (m != null) "." + m.groupValues[1].lowercase() else ".bin"
    } catch (e: Exception) { ".bin" }

    private fun sha1(s: String): String {
        val md = MessageDigest.getInstance("SHA-1")
        return md.digest(s.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
    }
}
