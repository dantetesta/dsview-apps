package com.dsview.player

import android.content.Context
import android.content.Intent
import androidx.core.content.FileProvider
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * Auto-update via GitHub Releases (repo público dsview-apps). Sem servidor de update próprio: o
 * "latest" já existe de graça no GitHub, e cada release já carrega o APK versionado no nome do
 * arquivo (dsview-android-X.Y.Z.apk) — extrair a versão do NOME do asset, não da tag do release,
 * porque um release combina os dois apps (a tag pode ter mudado só por causa do Windows).
 * Espelha o updater.js do app Windows — mesma lógica, plataforma diferente.
 *
 * O Android NUNCA deixa um app se atualizar em silêncio (fora de ser app de sistema/Play Store):
 * o máximo que dá pra fazer é baixar o APK e abrir o instalador do sistema já apontando pra ele —
 * o usuário sempre confirma. `REQUEST_INSTALL_PACKAGES` (manifest) + `FileProvider` (não dá pra
 * compartilhar um `file://` cru com outro app desde o Android 7) são os dois requisitos.
 */
object Updater {
    private const val REPO = "dantetesta/dsview-apps"
    private val ASSET_RE = Regex("^dsview-android-(\\d+\\.\\d+\\.\\d+)\\.apk$")

    data class Asset(val version: String, val url: String, val size: Long)

    /** Progresso do download em curso, polido pelo setup via /dsf/update-status (mesmo padrão do
     * sync-status do syncer — HTTP local não empurra evento, só responde quem pergunta). */
    @Volatile var status: JSONObject = JSONObject().put("phase", "idle")
        private set

    /** Compara "a" com "b" (semver X.Y.Z): >0 se a>b, <0 se a<b, 0 se igual. Pura — testável. */
    fun compareVersions(a: String, b: String): Int {
        val pa = a.split(".").map { it.toIntOrNull() ?: 0 }
        val pb = b.split(".").map { it.toIntOrNull() ?: 0 }
        for (i in 0..2) {
            val d = (pa.getOrElse(i) { 0 }) - (pb.getOrElse(i) { 0 })
            if (d != 0) return if (d > 0) 1 else -1
        }
        return 0
    }

    /** Acha o asset do Android entre os assets de um release e extrai a versão do NOME do arquivo.
     * Pura — testável sem rede/Context. */
    fun findAndroidAsset(assets: JSONArray?): Asset? {
        if (assets == null) return null
        for (i in 0 until assets.length()) {
            val a = assets.optJSONObject(i) ?: continue
            val m = ASSET_RE.find(a.optString("name")) ?: continue
            return Asset(m.groupValues[1], a.optString("browser_download_url"), a.optLong("size"))
        }
        return null
    }

    /** Verifica o último release do GitHub e compara com a versão instalada. Bloqueante (chame fora da UI thread). */
    fun checkLatest(context: Context): JSONObject {
        val conn = (URL("https://api.github.com/repos/$REPO/releases/latest").openConnection() as HttpURLConnection).apply {
            connectTimeout = 15000
            readTimeout = 15000
            setRequestProperty("Accept", "application/vnd.github+json")
            setRequestProperty("User-Agent", "DSView-Updater")
        }
        try {
            if (conn.responseCode != 200) throw RuntimeException("GitHub respondeu HTTP ${conn.responseCode}")
            val body = conn.inputStream.bufferedReader().use { it.readText() }
            val asset = findAndroidAsset(JSONObject(body).optJSONArray("assets"))
                ?: throw RuntimeException("O último release não tem APK do Android.")
            val current = context.packageManager.getPackageInfo(context.packageName, 0).versionName ?: "0.0.0"
            return JSONObject()
                .put("current", current)
                .put("latest", asset.version)
                .put("available", compareVersions(asset.version, current) > 0)
                .put("downloadUrl", asset.url)
                .put("size", asset.size)
        } finally {
            conn.disconnect()
        }
    }

    /** Baixa o APK pra dentro do cache do app e devolve o arquivo. Atualiza `status` a cada pedaço. */
    private fun download(url: String, cacheDir: File): File {
        val dst = File(cacheDir, "update.apk")
        val part = File(cacheDir, "update.apk.part")
        val conn = (URL(url).openConnection() as HttpURLConnection).apply {
            instanceFollowRedirects = true
            connectTimeout = 15000
            readTimeout = 60000
        }
        try {
            if (conn.responseCode != 200) throw RuntimeException("HTTP ${conn.responseCode} ao baixar a atualização.")
            val total = conn.contentLengthLong
            var received = 0L
            conn.inputStream.use { input ->
                part.outputStream().use { out ->
                    val buf = ByteArray(8192)
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        out.write(buf, 0, n)
                        received += n
                        status = JSONObject().put("phase", "downloading").put("received", received).put("total", total)
                    }
                }
            }
            if (!part.renameTo(dst)) { part.copyTo(dst, overwrite = true); part.delete() }
            return dst
        } catch (e: Exception) {
            part.delete()
            throw e
        } finally {
            conn.disconnect()
        }
    }

    /** Dispara o instalador do sistema pro APK — SEMPRE pede confirmação do usuário, sem exceção
     * possível fora de ser app de sistema. */
    private fun install(context: Context, apk: File) {
        val uri = FileProvider.getUriForFile(context, context.packageName + ".fileprovider", apk)
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, "application/vnd.android.package-archive")
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        context.startActivity(intent)
    }

    /** Baixa e dispara a instalação. Roda numa thread própria — chame a partir de uma já fora da UI
     * (o servidor local já atende cada request na sua própria thread). */
    fun downloadAndInstall(context: Context, url: String) {
        try {
            val apk = download(url, context.cacheDir)
            status = JSONObject().put("phase", "installing")
            install(context, apk)
            status = JSONObject().put("phase", "idle")
        } catch (e: Exception) {
            status = JSONObject().put("phase", "error").put("error", e.message ?: "Falha ao atualizar.")
        }
    }
}
