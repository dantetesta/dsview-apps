package com.dsview.player

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class UpdaterTest {

    @Test
    fun `compareVersions maior patch vence`() {
        assertEquals(1, Updater.compareVersions("0.5.5", "0.5.4"))
    }

    @Test
    fun `compareVersions menor patch perde`() {
        assertEquals(-1, Updater.compareVersions("0.5.3", "0.5.4"))
    }

    @Test
    fun `compareVersions igual da zero`() {
        assertEquals(0, Updater.compareVersions("0.5.4", "0.5.4"))
    }

    @Test
    fun `compareVersions minor major pesam mais que patch`() {
        assertEquals(1, Updater.compareVersions("0.6.0", "0.5.99"))
        assertEquals(1, Updater.compareVersions("1.0.0", "0.99.99"))
    }

    @Test
    fun `findAndroidAsset acha o apk entre varios assets do release`() {
        val assets = JSONArray()
            .put(JSONObject().put("name", "dsview-windows-setup-0.4.3.exe").put("browser_download_url", "https://x/win-versioned.exe").put("size", 78000000))
            .put(JSONObject().put("name", "dsview-windows-setup.exe").put("browser_download_url", "https://x/win.exe").put("size", 78000000))
            .put(JSONObject().put("name", "dsview-android-0.5.5.apk").put("browser_download_url", "https://x/android-versioned.apk").put("size", 2900000))
            .put(JSONObject().put("name", "dsview-android.apk").put("browser_download_url", "https://x/android.apk").put("size", 2900000))
        val found = Updater.findAndroidAsset(assets)
        assertEquals("0.5.5", found?.version)
        assertEquals("https://x/android-versioned.apk", found?.url)
        assertEquals(2900000L, found?.size)
    }

    @Test
    fun `findAndroidAsset release sem apk do Android devolve null`() {
        val assets = JSONArray().put(JSONObject().put("name", "dsview-windows-setup-0.4.3.exe").put("browser_download_url", "https://x/a.exe").put("size", 1))
        assertNull(Updater.findAndroidAsset(assets))
    }

    @Test
    fun `findAndroidAsset lista vazia ou nula devolve null sem lancar`() {
        assertNull(Updater.findAndroidAsset(JSONArray()))
        assertNull(Updater.findAndroidAsset(null))
    }
}
