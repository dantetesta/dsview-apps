package com.dsview.player

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.provider.Settings
import android.util.Log

/**
 * Auto-start: abre o kiosk sozinho quando o aparelho liga.
 *
 * ⚠️ A parte difícil não é receber o boot, é ter PERMISSÃO de abrir uma tela a partir dele.
 * Do Android 10 (API 29) em diante, iniciar Activity com o app em segundo plano é bloqueado
 * (background activity start). Um `startActivity` aqui simplesmente não faz nada, e sem registro a
 * pessoa só descobre que a TV ficou parada na tela do sistema depois de uma queda de energia.
 *
 * Os três caminhos, do mais forte para o mais fraco:
 *  1. App definido como TELA INICIAL do aparelho (categoria HOME no manifesto). O sistema abre a
 *     tela inicial ao ligar, então não depende de permissão nem deste receiver. É o recomendado.
 *  2. Permissão "sobrepor a outros apps" concedida: é a isenção oficial da regra acima.
 *  3. Nada disso: tentamos assim mesmo, porque muita ROM de TV Box não aplica a restrição.
 *
 * O resultado da tentativa fica em `Config.lastBootLaunch` e aparece no Diagnóstico — assim dá para
 * saber se o auto-start funcionou sem estar na frente do aparelho.
 */
class BootReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val acao = intent.action ?: return
        if (acao !in ACOES) return

        val config = Config(context)
        if (!config.autostart) return

        val podeSobrepor = Build.VERSION.SDK_INT < Build.VERSION_CODES.M || Settings.canDrawOverlays(context)
        val launch = Intent(context, MainActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        }

        val resultado = try {
            context.startActivity(launch)
            // "Sem erro" não garante que abriu: quando o sistema bloqueia, ele apenas ignora.
            // Por isso registramos também se havia permissão de sobreposição no momento.
            if (podeSobrepor) "aberto" else "tentado, sem permissão de sobreposição"
        } catch (e: Exception) {
            Log.w(App.TAG, "auto-start falhou", e)
            "falhou: " + (e.message ?: e.javaClass.simpleName)
        }

        config.lastBootLaunch = acao.substringAfterLast('.') + " -> " + resultado
    }

    companion object {
        /**
         * BOOT_COMPLETED é o padrão, mas caixas Amlogic/MediaTek (a maioria dos TV Box baratos)
         * mandam QUICKBOOT_POWERON. MY_PACKAGE_REPLACED faz o app voltar a tocar após atualizar.
         */
        private val ACOES = setOf(
            Intent.ACTION_BOOT_COMPLETED,
            "android.intent.action.QUICKBOOT_POWERON",
            "com.htc.intent.action.QUICKBOOT_POWERON",
            "android.intent.action.REBOOT",
            Intent.ACTION_MY_PACKAGE_REPLACED,
        )
    }
}
