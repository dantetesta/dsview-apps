package com.dsview.player

import android.content.Context
import org.json.JSONObject
import java.io.File

/**
 * "Última versão boa" do payload (o ORIGINAL, sem reescrita de URL). Persistido em disco para
 * o app abrir offline após um reboot. Espelha o state.js do app Windows.
 */
class StateStore(context: Context) {
    private val file = File(context.applicationContext.filesDir, "last-good.json")
    private var mem: JSONObject? = null

    @Synchronized
    fun get(): JSONObject? {
        mem?.let { return it }
        return try { JSONObject(file.readText()).also { mem = it } } catch (e: Exception) { null }
    }

    @Synchronized
    fun set(payload: JSONObject?) {
        mem = payload
        try {
            if (payload != null) file.writeText(payload.toString()) else file.delete()
        } catch (e: Exception) { /* tolera disco cheio */ }
    }

    @Synchronized
    fun clear() {
        mem = null
        try { file.delete() } catch (e: Exception) {}
    }
}
