package com.dsview.player

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ResolverTest {

    @Test
    fun `parsePlayUrl link canonico play token`() {
        val r = Resolver.parsePlayUrl("https://dsfacil.com.br/play/8f2a91")
        assertEquals("https://dsfacil.com.br", r?.origin)
        assertEquals("8f2a91", r?.token)
    }

    @Test
    fun `parsePlayUrl aceita barra final`() {
        val r = Resolver.parsePlayUrl("https://dsfacil.com.br/play/8f2a91/")
        assertEquals("https://dsfacil.com.br", r?.origin)
        assertEquals("8f2a91", r?.token)
    }

    @Test
    fun `parsePlayUrl preserva a porta no origin`() {
        val r = Resolver.parsePlayUrl("https://site.com:8443/play/xyz")
        assertEquals("https://site.com:8443", r?.origin)
    }

    @Test
    fun `parsePlayUrl null quando nao e o caminho play`() {
        assertNull(Resolver.parsePlayUrl("https://dsfacil.com.br/outra-coisa/8f2a91"))
    }

    @Test
    fun `parsePlayUrl null pra codigo curto puro sem URL`() {
        assertNull(Resolver.parsePlayUrl("12345"))
    }

    @Test
    fun `parsePlayUrl null pra string que nao e URL valida`() {
        assertNull(Resolver.parsePlayUrl("não é url nenhuma"))
    }

    @Test
    fun `parsePlayUrl token so aceita alfanumerico`() {
        val r = Resolver.parsePlayUrl("https://site.com/play/abc123")
        assertEquals("abc123", r?.token)
    }
}
