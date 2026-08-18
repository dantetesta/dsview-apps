package com.dsview.player

import org.junit.Assert.assertEquals
import org.junit.Test

class HeartbeatTest {
    @Test
    fun `jitter espalha aparelhos entre 60 e 75 segundos`() {
        assertEquals(HEARTBEAT_MS, heartbeatDelay(0.0))
        assertEquals(HEARTBEAT_MS + HEARTBEAT_JITTER_MS, heartbeatDelay(1.0))
        assertEquals(67_500L, heartbeatDelay(0.5))
    }
}
