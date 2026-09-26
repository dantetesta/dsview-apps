package com.dsview.player

import android.content.Context
import org.json.JSONObject
import java.io.File

/**
 * "Última versão boa" do payload (o ORIGINAL, sem reescrita de URL). Persistido em disco para
 * o app abrir offline após um reboot. Espelha o state.js do app Windows.
 */
class StateStore internal constructor(private val file: File) {
    constructor(context: Context) : this(File(context.applicationContext.filesDir, "last-good.json"))
    private var mem: JSONObject? = null

    @Synchronized
    fun get(): JSONObject? {
        mem?.let { return it }
        return try { JSONObject(file.readText()).also { mem = it } } catch (e: Exception) { null }
    }

    @Synchronized
    fun set(payload: JSONObject?) {
        if (payload == null) { clear(); return }
        val part = File(file.path + ".part")
        try {
            part.outputStream().use { out ->
                out.write(payload.toString().toByteArray(Charsets.UTF_8))
                out.fd.sync()
            }
            if (!part.renameTo(file)) throw java.io.IOException("Falha ao salvar playlist offline")
            mem = payload
        } finally { part.delete() }
    }

    @Synchronized
    fun clear() {
        mem = null
        try { file.delete() } catch (e: Exception) {}
    }
}
