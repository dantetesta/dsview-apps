package com.dsview.player

/** Reduz o número de decoders simultâneos em aparelhos de sinalização com pouca memória. */
internal object VideoPlaybackPolicy {
    fun conserveMemory(lowRamDevice: Boolean, totalMemoryBytes: Long): Boolean =
        lowRamDevice || totalMemoryBytes in 1L..(1536L * 1024 * 1024)
}
