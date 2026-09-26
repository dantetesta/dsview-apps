package com.dsview.player

import android.content.SharedPreferences
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.lang.reflect.Proxy
import java.nio.file.Files
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

class SyncIntegrityTest {
    private fun fixture(test: (TestHttpServer, String, Config, MediaCache, StateStore, Syncer) -> Unit) {
        val dir = Files.createTempDirectory("dsview-sync-test").toFile()
        TestHttpServer().use { server ->
            val base = "http://127.0.0.1:${server.port}"
            val config = Config(preferences()).apply { origin = base; token = "demo" }
            val cache = MediaCache(File(dir, "media"))
            val state = StateStore(File(dir, "last-good.json"))
            try { test(server, base, config, cache, state, Syncer(config, cache, state, "test")) }
            finally { dir.deleteRecursively() }
        }
    }

    @Test fun `same version repairs legacy cache and a failed update keeps last good playlist`() = fixture { server, base, _, cache, state, sync ->
        val version = AtomicInteger(1)
        val mediaStatus = AtomicInteger(200)
        server.createContext("/wp-json/ds-facil/v1/player/demo") { it.json(JSONObject().put("status", "ok").put("payload", payload(version.get(), "$base/video${version.get()}.mp4"))) }
        val downloaded = AtomicInteger()
        for (v in 1..2) server.createContext("/video$v.mp4") { exchange ->
            downloaded.incrementAndGet()
            exchange.sendResponseHeaders(mediaStatus.get(), 4)
            exchange.responseBody.use { it.write(byteArrayOf(1, 2, 3, 4)) }
        }
        cache.filePath("$base/video1.mp4").writeBytes(byteArrayOf(9))
        state.set(payload(1, "$base/video1.mp4"))
        assertTrue(sync.syncOnce().getBoolean("ok"))
        assertEquals(1, downloaded.get())
        assertTrue(cache.isVerified("$base/video1.mp4"))
        version.set(2)
        mediaStatus.set(503)
        assertFalse(sync.syncOnce().getBoolean("ok"))
        assertEquals("1", state.get()!!.getString("version"))
        assertTrue(cache.has("$base/video1.mp4"))
        assertEquals("partial", sync.lastStatus.getString("phase"))
        mediaStatus.set(200)
        assertTrue(sync.syncOnce().getBoolean("ok"))
        assertEquals("2", state.get()!!.getString("version"))
        assertTrue(cache.isVerified("$base/video2.mp4"))
    }

    @Test fun `authentication downloads media even when auth supplied that same payload`() = fixture { server, base, _, cache, state, sync ->
        val p = payload(1, "$base/video.mp4")
        server.createContext("/wp-json/ds-facil/v1/player/demo/auth") { it.json(JSONObject().put("status", "ok").put("device", "device").put("payload", p)) }
        server.createContext("/wp-json/ds-facil/v1/player/demo") { it.json(JSONObject().put("status", "ok").put("payload", p)) }
        server.createContext("/video.mp4") { it.sendResponseHeaders(200, 4); it.responseBody.use { out -> out.write(byteArrayOf(1, 2, 3, 4)) } }
        assertEquals("ok", sync.authenticate("").getString("status"))
        assertTrue(cache.isVerified("$base/video.mp4"))
        assertEquals("1", state.get()!!.getString("version"))
    }

    @Test fun `playlist switch invalidates in flight download and prevents old snapshot commit`() = fixture { server, base, config, cache, state, sync ->
        server.createContext("/wp-json/ds-facil/v1/player/demo") { it.json(JSONObject().put("status", "ok").put("payload", payload(1, "$base/video.mp4"))) }
        val started = CountDownLatch(1)
        val release = CountDownLatch(1)
        server.createContext("/video.mp4") {
            it.sendResponseHeaders(200, 4)
            started.countDown()
            release.await(5, TimeUnit.SECONDS)
            try { it.responseBody.use { out -> out.write(byteArrayOf(1, 2, 3, 4)) } } catch (_: Exception) {}
        }
        val pool = Executors.newSingleThreadExecutor()
        try {
            val job = pool.submit<JSONObject> { sync.syncOnce() }
            assertTrue(started.await(5, TimeUnit.SECONDS))
            sync.changePlaylist(base, "other", "other")
            release.countDown()
            assertEquals("superseded", job.get(5, TimeUnit.SECONDS).getString("reason"))
            assertNull(state.get())
            assertEquals("other", config.token)
            assertFalse(cache.has("$base/video.mp4"))
        } finally { release.countDown(); pool.shutdownNow() }
    }

    @Test fun `images logos and fallbacks are deduplicated ahead of videos`() = fixture { _, _, _, _, _, sync ->
        val queue = JSONArray()
            .put(JSONObject().put("kind", "video").put("src", "https://example.test/movie.mp4").put("fallback_src", "https://example.test/fallback.jpg"))
            .put(JSONObject().put("kind", "image").put("src", "https://example.test/photo.jpg").put("source_logo", "https://example.test/fallback.jpg"))
        assertEquals(listOf("https://example.test/fallback.jpg", "https://example.test/photo.jpg", "https://example.test/movie.mp4"), sync.cacheableUrls(JSONObject().put("queue", queue)))
    }

    @Test fun `saving same playlist preserves device and last good snapshot for offline reuse`() = fixture { _, base, config, _, state, sync ->
        config.device = "paired-device"
        state.set(payload(1, "$base/legacy.mp4"))
        sync.changePlaylist(base, "demo", "same playlist")
        assertEquals("paired-device", config.device)
        assertEquals("1", state.get()!!.getString("version"))
    }

    @Test fun `failed state commit never replaces last good memory`() {
        val dir = Files.createTempDirectory("dsview-state-test").toFile()
        val file = File(dir, "last-good.json")
        val state = StateStore(file)
        try {
            state.set(JSONObject().put("version", "old"))
            assertTrue(file.delete())
            assertTrue(file.mkdir())
            try { state.set(JSONObject().put("version", "new")); fail("commit unexpectedly succeeded") }
            catch (_: java.io.IOException) {}
            assertEquals("old", state.get()!!.getString("version"))
            assertFalse(File(file.path + ".part").exists())
        } finally { dir.deleteRecursively() }
    }

    private fun payload(version: Int, url: String) = JSONObject().put("version", version.toString())
        .put("queue", JSONArray().put(JSONObject().put("kind", "video").put("src", url)))

    private fun TestExchange.json(value: JSONObject) {
        val bytes = value.toString().toByteArray()
        responseHeaders.set("Content-Type", "application/json")
        sendResponseHeaders(200, bytes.size.toLong())
        responseBody.use { it.write(bytes) }
    }

    private fun preferences(): SharedPreferences {
        val data = java.util.concurrent.ConcurrentHashMap<String, Any>()
        val editor = Proxy.newProxyInstance(SharedPreferences.Editor::class.java.classLoader, arrayOf(SharedPreferences.Editor::class.java)) { self, method, args ->
            when {
                method.name.startsWith("put") -> { data[args!![0] as String] = args[1]; self }
                method.name == "apply" -> null
                method.name == "commit" -> true
                else -> self
            }
        }
        return Proxy.newProxyInstance(SharedPreferences::class.java.classLoader, arrayOf(SharedPreferences::class.java)) { _, method, args ->
            if (method.name == "edit") editor else data[args!![0] as String] ?: args[1]
        } as SharedPreferences
    }
}
