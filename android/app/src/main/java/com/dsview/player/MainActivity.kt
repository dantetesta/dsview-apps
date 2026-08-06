package com.dsview.player

import android.annotation.SuppressLint
import android.annotation.TargetApi
import android.app.AlertDialog
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.util.TypedValue
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.ConsoleMessage
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import java.net.URLEncoder

/**
 * Casca kiosk fullscreen em volta do player. Sem barra de URL. BACK/MENU abre o menu
 * (Configurações / Recarregar / Diagnóstico / Sair) — equivalente ao botão direito do app Windows.
 * Auto-start no boot é opcional, mas só entra sozinho no boot de verdade: se o usuário fechar de
 * propósito pelo "Sair", fica fechado até o aparelho reiniciar de novo (ver `Config.quitUntilBoot`).
 *
 * Compatibilidade (TV box Android 10 e afins): a criação do WebView, a porta do servidor local e a
 * morte do processo de renderização são TRATADAS. Qualquer uma delas falhando mostra uma tela preta
 * com o motivo escrito, nunca uma tela preta muda.
 */
class MainActivity : AppCompatActivity() {

    private var web: WebView? = null
    private val app: App get() = application as App
    private val base: String get() = "http://127.0.0.1:${app.server.listeningPort}"

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Usuário fechou de propósito neste mesmo boot (menu "Sair")? Respeita e não reabre
        // sozinho — nem se o Android reinvocar o app por ser a tela inicial do aparelho (HOME).
        // Só um boot novo (reiniciar de verdade) libera de novo. Sai antes de montar qualquer UI.
        if (app.config.quitUntilBoot == Config.bootId()) { finish(); return }

        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) // TV não apaga.

        // 1) O servidor local precisa estar de pé — é ele que serve setup, player e mídia.
        if (!app.serverOk) {
            showError(app.startupError ?: "O servidor local não subiu.")
            return
        }
        // 2) O WebView do sistema pode estar ausente, desativado ou em atualização (comum em TV box).
        val w = createWebView() ?: return
        web = w
        setContentView(w)
        route()
    }

    /** Cria e configura o WebView. Devolve null (e mostra a tela de erro) se o sistema não tiver um. */
    @SuppressLint("SetJavaScriptEnabled")
    private fun createWebView(): WebView? {
        val w = try {
            WebView(this)
        } catch (e: Throwable) {
            showError(
                "O WebView do sistema não está disponível neste aparelho.\n\n" +
                    "Instale ou ative o \"Android System WebView\" (ou o Chrome) na Play Store / " +
                    "Configurações > Apps, e abra o DS View de novo.\n\n" + e.toString()
            )
            return null
        }
        w.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            @Suppress("DEPRECATION")
            databaseEnabled = true
            mediaPlaybackRequiresUserGesture = false // autoplay COM som (respeita o flag `audio` de cada item)
            cacheMode = WebSettings.LOAD_DEFAULT
            useWideViewPort = true
            loadWithOverviewMode = true
            javaScriptCanOpenWindowsAutomatically = false
            setSupportZoom(false)
            builtInZoomControls = false
        }
        w.setBackgroundColor(Color.BLACK)
        w.overScrollMode = View.OVER_SCROLL_NEVER
        // DPAD: numa TV box sem touch, o WebView precisa do foco para o controle navegar no setup.
        w.isFocusable = true
        w.isFocusableInTouchMode = true
        // Deixa inspecionar por USB (chrome://inspect) — como não há logcat na casa do cliente.
        // SÓ em build de debug: em release isso fica ligado pra sempre no aparelho do cliente,
        // uma porta de depuração remota permanentemente aberta em produção.
        val debuggable = (applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0
        if (debuggable) { try { WebView.setWebContentsDebuggingEnabled(true) } catch (e: Throwable) {} }

        w.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(m: ConsoleMessage): Boolean {
                app.logJs("${m.messageLevel()} ${m.message()} (${m.sourceId()}:${m.lineNumber()})")
                return true
            }
        }
        w.webViewClient = object : WebViewClient() {
            @Deprecated("Deprecated in Java")
            override fun shouldOverrideUrlLoading(view: WebView?, url: String?): Boolean {
                if (url == null) return false
                val origin = app.config.origin
                val allowed = sameOrigin(url, base) || (origin.isNotEmpty() && sameOrigin(url, origin))
                return !allowed // true = bloqueia navegação externa (kiosk fechado)
            }

            /**
             * O processo de renderização do WebView morreu (falta de memória tocando vídeo em
             * aparelho fraco, ou crash do próprio WebView). Sem tratar isto o Android MATA o app
             * inteiro — é a causa clássica de "a TV simplesmente apagou depois de um tempo".
             * Devolvendo true e recriando o WebView, o kiosk se levanta sozinho.
             */
            @TargetApi(Build.VERSION_CODES.O)
            override fun onRenderProcessGone(view: WebView?, detail: RenderProcessGoneDetail?): Boolean {
                app.logJs("render process morreu (crash=" + (detail?.didCrash() ?: false) + ") — recriando")
                recoverFromRendererDeath()
                return true
            }
        }
        return w
    }

    /** Mesma origem de verdade (esquema+host+porta), não prefixo de string: `url.startsWith(origin)`
     * deixava `origin + ".attacker.com"` passar como se fosse o site real — kiosk público, isso é
     * uma tela cheia de phishing/pichação sem ninguém perceber. */
    private fun sameOrigin(url: String, other: String): Boolean = try {
        val u1 = android.net.Uri.parse(url)
        val u2 = android.net.Uri.parse(other)
        u1.scheme == u2.scheme && u1.host == u2.host && effectivePort(u1) == effectivePort(u2)
    } catch (e: Exception) { false }

    private fun effectivePort(u: android.net.Uri): Int =
        if (u.port != -1) u.port else if (u.scheme == "https") 443 else 80

    // Recriar a CADA morte do processo de renderização, sem limite, vira loop de recriar→carregar→
    // morrer de novo (um vídeo pesado que estoura memória sempre no mesmo ponto, em TV box fraca) —
    // consome CPU/memória sem parar em vez de recuperar uma vez e ficar quieto. Backoff crescente.
    private var crashCount = 0
    private val crashResetMs = 10 * 60 * 1000L // 10 min sem crash = zera a contagem.
    private var lastCrashAt = 0L
    private val handler = android.os.Handler(android.os.Looper.getMainLooper())

    /** Descarta o WebView morto e monta outro do zero, voltando pra rota atual. */
    private fun recoverFromRendererDeath() {
        val now = System.currentTimeMillis()
        if (now - lastCrashAt > crashResetMs) crashCount = 0
        lastCrashAt = now
        crashCount += 1
        val delay = (crashCount * 5000L).coerceAtMost(60000L) // 5s, 10s, 15s ... até 60s no máximo.

        val dead = web
        web = null
        try {
            (dead?.parent as? ViewGroup)?.removeView(dead)
            dead?.destroy()
        } catch (e: Throwable) { /* já estava morto */ }

        handler.postDelayed({
            if (isFinishing || isDestroyed) return@postDelayed
            val fresh = createWebView() ?: return@postDelayed
            web = fresh
            setContentView(fresh)
            route()
        }, delay)
    }

    /** Decide a tela: player se configurado (e autenticado, no offline), senão setup. */
    private fun route() {
        val w = web ?: return
        val cfg = app.config
        if (!cfg.isConfigured) { w.loadUrl("$base/setup"); w.requestFocus(); return }
        if (!cfg.offline) { // só-online: página real do player
            w.loadUrl(cfg.origin.trimEnd('/') + "/play/" + cfg.token)
            return
        }
        if (cfg.device.isEmpty()) { w.loadUrl("$base/setup"); w.requestFocus(); return } // offline sem sessão → autentica no setup
        val token = URLEncoder.encode(cfg.token, "UTF-8")
        val device = URLEncoder.encode(cfg.device, "UTF-8")
        w.loadUrl("$base/player?token=$token&device=$device")
    }

    /** Tela preta com o motivo escrito. Substitui o "não abre / tela preta muda". */
    private fun showError(message: String) {
        val text = TextView(this).apply {
            setTextColor(Color.WHITE)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
            setPadding(48, 48, 48, 48)
            setLineSpacing(0f, 1.25f)
            this.text = "DS View\n\n" + message + "\n\n" + diagnosticsText() +
                "\n\nBACK/MENU abre o menu do app."
            isFocusable = true
        }
        val scroll = ScrollView(this).apply {
            setBackgroundColor(Color.BLACK)
            addView(text, FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT)
        }
        setContentView(scroll)
    }

    /** Dados que a gente precisa quando o aparelho está longe (o cliente fotografa a tela). */
    private fun diagnosticsText(): String {
        val sb = StringBuilder()
        sb.append("Versão do app: ").append(appVersion()).append('\n')
        sb.append("Android: ").append(Build.VERSION.RELEASE).append(" (API ").append(Build.VERSION.SDK_INT).append(")\n")
        sb.append("Aparelho: ").append(Build.MANUFACTURER).append(' ').append(Build.MODEL).append('\n')
        sb.append("WebView: ").append(webViewVersion()).append('\n')
        sb.append("Servidor local: ").append(if (app.serverOk) "porta ${app.server.listeningPort}" else "NÃO subiu")
        app.lastCrash()?.let { sb.append("\n\nÚltimo erro registrado:\n").append(it.take(1200)) }
        return sb.toString()
    }

    private fun appVersion(): String = try {
        packageManager.getPackageInfo(packageName, 0).versionName ?: "?"
    } catch (e: Exception) { "?" }

    private fun webViewVersion(): String = try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val p = WebView.getCurrentWebViewPackage()
            if (p == null) "AUSENTE" else p.packageName + " " + p.versionName
        } else "desconhecida (Android < 8)"
    } catch (e: Throwable) { "erro ao consultar" }

    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        if (keyCode == KeyEvent.KEYCODE_BACK || keyCode == KeyEvent.KEYCODE_MENU) {
            showMenu()
            return true
        }
        return super.onKeyDown(keyCode, event)
    }

    private fun showMenu() {
        AlertDialog.Builder(this)
            .setTitle(getString(R.string.app_name))
            .setItems(arrayOf("Configurações", "Recarregar (buscar mudanças)", "Diagnóstico", "Sair")) { _, which ->
                when (which) {
                    0 -> if (web != null && app.serverOk) web?.loadUrl("$base/setup") else showError("O servidor local não subiu.")
                    1 -> Thread {
                        try { app.syncer.syncOnce() } catch (e: Exception) {}
                        runOnUiThread { web?.reload() ?: route() }
                    }.start()
                    2 -> showDiagnostics()
                    3 -> { app.config.quitUntilBoot = Config.bootId(); finish() }
                }
            }
            .show()
    }

    private fun showDiagnostics() {
        val js = app.jsLog()
        AlertDialog.Builder(this)
            .setTitle("Diagnóstico")
            .setMessage(diagnosticsText() + if (js.isEmpty()) "" else "\n\nConsole do player:\n$js")
            .setPositiveButton("Fechar", null)
            .setNegativeButton("Limpar erro") { _, _ -> app.clearCrash() }
            .show()
    }

    override fun onResume() { super.onResume(); immersive() }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) immersive()
    }

    @Suppress("DEPRECATION")
    private fun immersive() {
        window.decorView.systemUiVisibility = (
            View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                or View.SYSTEM_UI_FLAG_FULLSCREEN
                or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
            )
    }

    override fun onDestroy() {
        try { web?.destroy() } catch (e: Throwable) {}
        web = null
        super.onDestroy()
    }
}
