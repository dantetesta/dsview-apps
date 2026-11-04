package com.dsview.player

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class VideoPlaybackPolicyTest {
    private val gib = 1024L * 1024 * 1024

    @Test fun `aparelho de 1 GB desativa a preparacao antecipada de video`() {
        assertTrue(VideoPlaybackPolicy.conserveMemory(false, gib))
    }

    @Test fun `sinalizacao low ram do fabricante prevalece sobre memoria total`() {
        assertTrue(VideoPlaybackPolicy.conserveMemory(true, 2 * gib))
    }

    @Test fun `aparelhos com memoria suficiente preservam a preparacao normal`() {
        assertFalse(VideoPlaybackPolicy.conserveMemory(false, 2 * gib))
    }

    @Test fun `consulta sem informacao nao classifica o aparelho como 1 GB`() {
        assertFalse(VideoPlaybackPolicy.conserveMemory(false, 0))
    }
}
