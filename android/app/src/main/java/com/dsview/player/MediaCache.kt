package com.dsview.player

import android.content.Context
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.io.IOException
import java.util.concurrent.ConcurrentHashMap

/**
 * Cache de mídia local (espelho do conteúdo online no disco). Espelha o cache.js do app Windows.
 * Nome do arquivo = sha1(url)+ext (determinístico). Download ATÔMICO: baixa para .part e só renomeia no fim.
 */
class MediaCache internal constructor(private val dir: File) {
    constructor(context: Context) : this(File(context.applicationContext.filesDir, "media"))
    init { dir.mkdirs() }
    private val verified = ConcurrentHashMap<String, String>()
    @Volatile private var generation = 0L

    fun dir(): File = dir
    fun fileName(url: String): String = sha1(url) + extOf(url)
    fun filePath(url: String): File = File(dir, fileName(url))
    fun has(url: String): Boolean {
        val file = filePath(url)
        // Legacy installations keep playing offline until the next successful repair download.
        return if (!File(file.path + ".verified").exists()) file.isFile && file.length() > 0 else isVerified(url)
    }

    fun isVerified(url: String): Boolean {
        val file = filePath(url)
        val marker = File(file.path + ".verified")
        if (!file.isFile || file.length() <= 0 || !marker.isFile) return false
        return try {
            val signature = "${file.length()}:${file.lastModified()}:${marker.lastModified()}"
            if (verified[file.name] == signature) return true
            val fields = marker.readText().trim().split(':')
            val valid = fields.size == 2 && fields[0].toLongOrNull() == file.length() && fields[1] == digest(file)
            if (valid) verified[file.name] = signature
            valid
        } catch (e: Exception) { false }
    }

    /** Baixa a URL para o disco (atômico). Lança em erro/HTTP != 200. */
    fun download(url: String, cancelled: () -> Boolean = { false }) {
        val epoch = generation
        val dst = filePath(url)
        val part = File.createTempFile(dst.name + ".", ".part", dir)
        val marker = File(dst.path + ".verified")
        val markerPart = File(part.path + ".verified")
        val conn = (URL(url).openConnection() as HttpURLConnection).apply {
            instanceFollowRedirects = true
            connectTimeout = 15000
            readTimeout = 60000
            setRequestProperty("Accept-Encoding", "identity")
        }
        try {
            if (conn.responseCode != 200) throw IOException("HTTP ${conn.responseCode} ao baixar mídia")
            if (conn.getHeaderField("Content-Range") != null) throw IOException("Resposta parcial inesperada")
            val type = conn.contentType.orEmpty().substringBefore(';').trim().lowercase()
            if (type == "text/html" || type == "application/json" || type.endsWith("+json"))
                throw IOException("Servidor devolveu documento em vez de mídia")
            val encoding = conn.getHeaderField("Content-Encoding").orEmpty()
            if (encoding.isNotEmpty() && !encoding.equals("identity", true)) throw IOException("Codificação inesperada da mídia")
            val expected = conn.getHeaderField("Content-Length")?.toLongOrNull()
            var size = 0L
            val hash = MessageDigest.getInstance("SHA-256")
            conn.inputStream.use { input -> part.outputStream().use { out ->
                val buffer = ByteArray(64 * 1024)
                while (true) {
                    if (cancelled() || epoch != generation || Thread.currentThread().isInterrupted) throw IOException("Download cancelado")
                    val count = input.read(buffer)
                    if (count < 0) break
                    out.write(buffer, 0, count)
                    hash.update(buffer, 0, count)
                    size += count
                }
                out.fd.sync()
            } }
            if (size == 0L || (expected != null && size != expected)) throw IOException("Mídia incompleta")
            markerPart.writeText("$size:${hex(hash.digest())}")
            synchronized(this) {
                if (cancelled() || epoch != generation) throw IOException("Download cancelado")
                // Same-directory rename is atomic. A copy fallback could expose half a video.
                if (!part.renameTo(dst)) throw IOException("Falha ao publicar mídia")
                verified.remove(dst.name)
                if (!markerPart.renameTo(marker)) {
                    marker.delete()
                    throw IOException("Falha ao validar mídia")
                }
            }
        } finally {
            part.delete()
            markerPart.delete()
            conn.disconnect()
        }
    }

    /** Remove os arquivos que não estão mais no conjunto de URLs em uso. */
    @Synchronized fun prune(keepUrls: List<String>): Int {
        val keep = keepUrls.flatMap { listOf(fileName(it), fileName(it) + ".verified") }.toHashSet()
        var removed = 0
        dir.listFiles()?.forEach { f ->
            if (f.name.endsWith(".part")) { f.delete(); return@forEach }
            if (!keep.contains(f.name)) { if (f.delete()) removed++ }
        }
        return removed
    }

    /** Apaga toda a mídia local (reset do cache). */
    @Synchronized fun clear(): Int {
        generation++
        verified.clear()
        var removed = 0
        dir.listFiles()?.forEach { if (it.delete()) removed++ }
        return removed
    }

    @Synchronized fun invalidateDownloads() { generation++ }

    private fun digest(file: File): String {
        val md = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val bytes = ByteArray(64 * 1024)
            while (true) {
                val n = input.read(bytes)
                if (n < 0) break
                md.update(bytes, 0, n)
            }
        }
        return hex(md.digest())
    }

    private fun hex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it) }

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
