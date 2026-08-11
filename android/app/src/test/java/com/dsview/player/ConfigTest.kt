package com.dsview.player

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ConfigTest {

    @Test
    fun `clampInterval clampa abaixo do minimo`() {
        assertEquals(Config.SYNC_MIN, Config.clampInterval(0))
    }

    @Test
    fun `clampInterval clampa acima do maximo`() {
        assertEquals(Config.SYNC_MAX, Config.clampInterval(999999))
    }

    @Test
    fun `clampInterval valor dentro da faixa passa direto`() {
        assertEquals(120, Config.clampInterval(120))
    }

    @Test
    fun `buildRealApi null sem origin`() {
        assertNull(Config.buildRealApi("", "abc"))
    }

    @Test
    fun `buildRealApi null sem token`() {
        assertNull(Config.buildRealApi("https://site.com", ""))
    }

    @Test
    fun `buildRealApi monta a rota certa e tira a barra final do origin`() {
        assertEquals(
            "https://site.com.br/wp-json/ds-facil/v1/player/xyz",
            Config.buildRealApi("https://site.com.br/", "xyz"),
        )
    }

    @Test
    fun `buildRealApi URL-encoda o token`() {
        // java.net.URLEncoder é application/x-www-form-urlencoded: espaço vira "+", não "%20".
        assertEquals(
            "https://site.com/wp-json/ds-facil/v1/player/a+b%2Fc",
            Config.buildRealApi("https://site.com", "a b/c"),
        )
    }

    @Test
    fun `normalizeDomain vazio devolve vazio`() {
        assertEquals("", Config.normalizeDomain(""))
        assertEquals("", Config.normalizeDomain("   "))
    }

    @Test
    fun `normalizeDomain aceita dominio nu e assume https`() {
        assertEquals("https://suaempresa.com.br", Config.normalizeDomain("suaempresa.com.br"))
    }

    @Test
    fun `normalizeDomain preserva scheme e porta ja informados`() {
        assertEquals("http://site.com:8080", Config.normalizeDomain("http://site.com:8080"))
    }

    @Test
    fun `normalizeDomain tira caminho e barra final`() {
        assertEquals("https://site.com", Config.normalizeDomain("https://site.com/play/xxxx"))
        assertEquals("https://site.com", Config.normalizeDomain("site.com/"))
    }

    @Test
    fun `normalizeDomain string invalida devolve vazio`() {
        assertEquals("", Config.normalizeDomain("não é um domínio"))
    }

    // Bug real: "Sair" (ou desligar o auto-start) deixava o app preso num loop de relançamento —
    // por ser HOME do aparelho, o Android religava na hora, e a supressão antiga (igualdade simples
    // de boot-id, sem prazo) durava até reiniciar o TV box inteiro. Estes testes travam o
    // comportamento correto: suprime só a rajada instantânea, nunca uma reabertura de verdade.
    @Test
    fun `shouldSuppress logo apos o fechamento no mesmo boot suprime`() {
        val boot = 555L
        val quitAt = 10_000L
        assertEquals(true, Config.shouldSuppress(boot, quitAt, boot, quitAt + 1_000L))
    }

    @Test
    fun `shouldSuppress passada a janela nao suprime mesmo no mesmo boot`() {
        val boot = 556L
        val quitAt = 10_000L
        val muitoDepois = quitAt + Config.AUTO_RELAUNCH_SUPPRESS_MS + 1_000L
        assertEquals(false, Config.shouldSuppress(boot, quitAt, boot, muitoDepois))
    }

    @Test
    fun `shouldSuppress boot diferente nunca suprime`() {
        assertEquals(false, Config.shouldSuppress(777L, 10_000L, 778L, 10_500L))
    }

    @Test
    fun `shouldSuppress nunca fechou de proposito nao suprime`() {
        assertEquals(false, Config.shouldSuppress(0L, 0L, 999L, 999_999L))
    }

    @Test
    fun `shouldSuppress config legado sem quitAt nao suprime`() {
        assertEquals(false, Config.shouldSuppress(42L, 0L, 42L, 100L))
    }
}
