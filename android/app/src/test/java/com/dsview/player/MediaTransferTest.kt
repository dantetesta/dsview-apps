package com.dsview.player

import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

class MediaTransferTest {
    @Test fun `range suffix reads the trailer and invalid ranges are rejected`() {
        assertEquals(90L..99L, parseMediaRange("bytes=-10", 100))
        assertEquals(0L..99L, parseMediaRange("bytes=-1000", 100))
        assertEquals(10L..99L, parseMediaRange("bytes=10-", 100))
        assertEquals(10L..99L, parseMediaRange("bytes=10-200", 100))
        for (header in listOf("bytes=-0", "bytes=100-", "bytes=50-40", "bytes=1-2,4-5", "garbage", "bytes=-", "bytes=99999999999999999999-"))
            assertNull(header, parseMediaRange(header, 100))
    }

    @Test fun `three downloads overlap while a slow video does not block following images`() {
        val active = AtomicInteger(0)
        val max = AtomicInteger(0)
        val threeStarted = CountDownLatch(3)
        val allImages = CountDownLatch(6)
        val release = CountDownLatch(1)
        val pool = Executors.newSingleThreadExecutor()
        try {
            val job = pool.submit<Int> {
                downloadInParallel(listOf("video") + (1..6).map { "image$it" }) { url ->
                    val count = active.incrementAndGet()
                    max.updateAndGet { previous -> maxOf(previous, count) }
                    threeStarted.countDown()
                    assertTrue(threeStarted.await(5, TimeUnit.SECONDS))
                    if (url == "video") release.await(5, TimeUnit.SECONDS) else allImages.countDown()
                    active.decrementAndGet()
                }
            }
            assertTrue(allImages.await(5, TimeUnit.SECONDS))
            assertFalse(job.isDone)
            assertEquals(3, max.get())
            release.countDown()
            assertEquals(7, job.get(5, TimeUnit.SECONDS))
        } finally { release.countDown(); pool.shutdownNow() }
    }

    @Test fun `one failed download does not stop the remaining files`() {
        assertEquals(2, downloadInParallel(listOf("one", "broken", "two")) { if (it == "broken") throw java.io.IOException("truncated") })
    }
}
