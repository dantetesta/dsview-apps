package com.dsview.player

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ConfigTest {

    @Test
    fun `clampInterval clampa abaixo do minimo`() {
        assertEquals(Config.SYNC_MIN, Config.clampInterval(1))
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
}
