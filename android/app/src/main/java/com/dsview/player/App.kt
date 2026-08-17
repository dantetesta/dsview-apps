package com.dsview.player

import android.app.Application
import android.util.Log
import fi.iki.elonen.NanoHTTPD
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Singletons do app: config, cache, estado, sync e o servidor local (sobem uma vez por processo).
 *
 * Regra de ouro deste arquivo: **nada aqui pode falhar em silêncio**. Em TV box não dá pra abrir o
 * logcat; se algo quebrar, o app tem que MOSTRAR o motivo na tela (a MainActivity lê `startupError`
 * e `lastCrash()`), senão o sintoma vira "instala e não abre" e ficamos cegos.
 */
class App : Application() {
    lateinit var config: Config
    lateinit var cache: MediaCache
    lateinit var state: StateStore
    lateinit var syncer: Syncer
    lateinit var server: LocalServer

    /** Motivo da falha de inicialização (null = subiu tudo). Mostrado na tela pela MainActivity. */
    @Volatile var startupError: String? = null
        private set

    /** O servidor local está de pé e com porta válida? Sem isso o WebView carregaria `127.0.0.1:-1`. */
    val serverOk: Boolean get() = ::server.isInitialized && server.wasStarted() && server.listeningPort > 0

    override fun onCreate() {
        super.onCreate()
        installCrashHandler()
        try {
            config = Config(this)
            cache = MediaCache(this)
            state = StateStore(this)
            val version = try {
                packageManager.getPackageInfo(packageName, 0).versionName ?: ""
            } catch (e: Exception) {
                ""
            }
            syncer = Syncer(config, cache, state, version)
            server = LocalServer(this, config, cache, state, syncer)
            startupError = startServer()
            if (startupError == null) syncer.start()
        } catch (e: Throwable) {
            startupError = "Falha ao iniciar o app: " + describe(e)
            Log.e(TAG, "startup", e)
        }
    }

    /**
     * Sobe o NanoHTTPD com algumas tentativas (porta 0 = o sistema escolhe; em ROM de TV box a 1ª
     * tentativa às vezes falha logo após o boot, com a rede ainda subindo).
     * Devolve null em sucesso, ou a mensagem de erro.
     */
    private fun startServer(): String? {
        var last: Throwable? = null
        repeat(3) { attempt ->
            try {
                server.start(NanoHTTPD.SOCKET_READ_TIMEOUT, false)
                if (server.wasStarted() && server.listeningPort > 0) return null
                last = RuntimeException("servidor iniciou sem porta válida")
            } catch (e: Throwable) {
                last = e
                Log.w(TAG, "tentativa ${attempt + 1} de subir o servidor local falhou", e)
            }
            try { server.stop() } catch (e: Exception) { /* só limpando pra tentar de novo */ }
            try { Thread.sleep(400) } catch (e: InterruptedException) { /* segue */ }
        }
        return "Não consegui abrir o servidor local (127.0.0.1). " + describe(last)
    }

    /**
     * Guarda o stack trace do último crash em disco e deixa o handler padrão seguir (o sistema
     * continua matando o processo). Na abertura seguinte a tela de erro mostra o texto — é o
     * substituto do logcat quando o aparelho está na casa do cliente.
     */
    private fun installCrashHandler() {
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, e ->
            try {
                val stamp = SimpleDateFormat("dd/MM/yyyy HH:mm:ss", Locale.getDefault()).format(Date())
                crashFile().writeText(stamp + "\n" + Log.getStackTraceString(e))
            } catch (io: Throwable) { /* disco cheio: não piorar o crash */ }
            previous?.uncaughtException(thread, e)
        }
    }

    /** Últimas linhas de console do WebView (erro de JS aparece aqui). Anel de 40, só em memória. */
    private val jsLines = ArrayList<String>()

    fun logJs(line: String) {
        Log.d(TAG, "js: $line")
        synchronized(jsLines) {
            jsLines.add(line)
            while (jsLines.size > 40) jsLines.removeAt(0)
        }
    }

    fun jsLog(): String = synchronized(jsLines) { jsLines.joinToString("\n") }

    fun crashFile(): File = File(filesDir, "crash.txt")

    /** Texto do último crash (ou null). */
    fun lastCrash(): String? = try {
        val f = crashFile()
        if (f.exists() && f.length() > 0) f.readText().take(4000) else null
    } catch (e: Exception) { null }

    fun clearCrash() { try { crashFile().delete() } catch (e: Exception) {} }

    /** Repassa saúde ao heartbeat somente se o Syncer chegou a ser inicializado. */
    fun reportHealth(health: String, error: String = "") {
        if (::syncer.isInitialized) syncer.setHealth(health, error)
    }

    private fun describe(e: Throwable?): String =
        if (e == null) "motivo desconhecido" else (e.javaClass.simpleName + ": " + (e.message ?: ""))

    companion object {
        const val TAG = "DSViewTV"
    }
}
