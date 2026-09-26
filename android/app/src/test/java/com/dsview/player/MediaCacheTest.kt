package com.dsview.player

import org.junit.Assert.*
import org.junit.Test
import java.net.ServerSocket
import java.net.Socket
import java.nio.file.Files
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

class MediaCacheTest {
    private fun withServer(test: (TestHttpServer, String, MediaCache) -> Unit) {
        val dir = Files.createTempDirectory("dsview-cache-test").toFile()
        val server = TestHttpServer()
        try { test(server, "http://127.0.0.1:${server.port}", MediaCache(dir)) }
        finally { server.close(); dir.deleteRecursively() }
    }

    @Test fun `large videos are streamed intact and verified after restarting cache`() = withServer { server, base, cache ->
        val chunk = ByteArray(64 * 1024) { (it % 251).toByte() }
        for (megabytes in listOf(25, 99)) {
            val size = megabytes * 1024 * 1024
            server.createContext("/$megabytes.mp4") { exchange ->
                assertEquals("identity", exchange.requestHeaders.getFirst("Accept-Encoding"))
                exchange.responseHeaders.set("Content-Type", "video/mp4")
                exchange.sendResponseHeaders(200, size.toLong())
                exchange.responseBody.use { out -> repeat(size / chunk.size) { out.write(chunk) } }
            }
            val url = "$base/$megabytes.mp4"
            cache.download(url)
            assertEquals(size.toLong(), cache.filePath(url).length())
            assertTrue(MediaCache(cache.dir()).isVerified(url))
            cache.filePath(url).inputStream().use { input ->
                val actual = ByteArray(chunk.size)
                repeat(size / chunk.size) {
                    java.io.DataInputStream(input).readFully(actual)
                    assertArrayEquals(chunk, actual)
                }
            }
        }
    }

    @Test fun `truncated empty error pages and partial responses never replace a good file`() = withServer { server, base, cache ->
        val mode = AtomicInteger(0)
        server.createContext("/video.mp4") { exchange ->
            when (mode.get()) {
                0 -> { exchange.sendResponseHeaders(200, 4); exchange.responseBody.use { it.write(byteArrayOf(1, 2, 3, 4)) } }
                1 -> { exchange.sendResponseHeaders(200, 1000); try { exchange.responseBody.use { it.write(byteArrayOf(9, 8)) } } catch (_: Exception) {} }
                2 -> { exchange.responseHeaders.set("Content-Type", "text/html"); exchange.sendResponseHeaders(200, 4); exchange.responseBody.use { it.write("oops".toByteArray()) } }
                3 -> { exchange.sendResponseHeaders(206, 4); exchange.responseBody.use { it.write("oops".toByteArray()) } }
                else -> { exchange.sendResponseHeaders(200, -1); exchange.close() }
            }
        }
        val url = "$base/video.mp4"
        cache.download(url)
        for (bad in 1..4) {
            mode.set(bad)
            try { cache.download(url); fail("accepted invalid download $bad") } catch (_: java.io.IOException) {}
            assertTrue(cache.isVerified(url))
            assertArrayEquals(byteArrayOf(1, 2, 3, 4), cache.filePath(url).readBytes())
            assertFalse(cache.dir().listFiles()!!.any { it.name.contains(".part") })
        }
    }

    @Test fun `unknown length octet stream is accepted and changed cache is rejected`() = withServer { server, base, cache ->
        server.createContext("/image.bin") { exchange ->
            exchange.responseHeaders.set("Content-Type", "application/octet-stream")
            exchange.sendResponseHeaders(200, 0)
            exchange.responseBody.use { it.write(byteArrayOf(3, 4, 5)) }
        }
        val url = "$base/image.bin"
        cache.download(url)
        assertTrue(cache.has(url))
        cache.filePath(url).writeBytes(byteArrayOf(8, 8, 8))
        assertFalse(MediaCache(cache.dir()).has(url))
    }

    @Test fun `legacy cache remains playable offline but must be repaired online`() = withServer { _, base, cache ->
        val url = "$base/legacy.mp4"
        cache.filePath(url).writeBytes(byteArrayOf(1, 2, 3))
        assertTrue(cache.has(url))
        assertFalse(cache.isVerified(url))
    }

    @Test fun `clearing during a download cannot resurrect its file`() = withServer { server, base, cache ->
        val started = CountDownLatch(1)
        val release = CountDownLatch(1)
        server.createContext("/video.mp4") { exchange ->
            exchange.sendResponseHeaders(200, 4)
            started.countDown()
            release.await(5, TimeUnit.SECONDS)
            try { exchange.responseBody.use { it.write(byteArrayOf(1, 2, 3, 4)) } } catch (_: Exception) {}
        }
        val pool = Executors.newSingleThreadExecutor()
        try {
            val job = pool.submit<Boolean> { try { cache.download("$base/video.mp4"); true } catch (_: Exception) { false } }
            assertTrue(started.await(5, TimeUnit.SECONDS))
            cache.clear()
            release.countDown()
            assertFalse(job.get(5, TimeUnit.SECONDS))
            assertTrue(cache.dir().listFiles()!!.isEmpty())
        } finally { release.countDown(); pool.shutdownNow() }
    }
}

/** Raw HTTP fixture intentionally supports a declared length larger than the bytes sent. */
internal class TestHttpServer : java.io.Closeable {
    private val socket = ServerSocket(0, 50, java.net.InetAddress.getByName("127.0.0.1"))
    private val pool = Executors.newCachedThreadPool()
    private val handlers = java.util.concurrent.ConcurrentHashMap<String, (TestExchange) -> Unit>()
    val port get() = socket.localPort
    init {
        pool.submit {
            while (!socket.isClosed) {
                val client = try { socket.accept() } catch (_: java.io.IOException) { break }
                pool.submit { client.use { handlers[TestExchange.path(it)]?.invoke(TestExchange(it)) } }
            }
        }
    }
    fun createContext(path: String, handler: (TestExchange) -> Unit) { handlers[path] = handler }
    override fun close() { socket.close(); pool.shutdownNow() }
}

internal class TestHeaders : LinkedHashMap<String, String>() {
    fun set(key: String, value: String) { put(key, value) }
    fun getFirst(key: String) = entries.firstOrNull { it.key.equals(key, true) }?.value
}

internal class TestExchange(private val socket: Socket) {
    val responseHeaders = TestHeaders()
    val requestHeaders = TestHeaders()
    val responseBody get() = socket.getOutputStream()
    init {
        val reader = socket.getInputStream().bufferedReader()
        while (true) {
            val line = reader.readLine() ?: break
            if (line.isEmpty()) break
            requestHeaders.set(line.substringBefore(':'), line.substringAfter(':').trim())
        }
    }
    fun sendResponseHeaders(status: Int, length: Long) {
        responseHeaders.set("Connection", "close")
        if (length != 0L) responseHeaders.set("Content-Length", maxOf(0L, length).toString())
        responseBody.write(("HTTP/1.1 $status Response\r\n" + responseHeaders.entries.joinToString("") { "${it.key}: ${it.value}\r\n" } + "\r\n").toByteArray())
        responseBody.flush()
    }
    fun close() { socket.close() }
    companion object {
        fun path(socket: Socket): String {
            // Read only the first line, without buffering the remaining request headers.
            val line = StringBuilder()
            while (true) { val b = socket.getInputStream().read(); if (b < 0 || b == 10) break; if (b != 13) line.append(b.toChar()) }
            return line.toString().split(' ')[1].substringBefore('?')
        }
    }
}
