# NanoHTTPD e o bridge JS não podem ser ofuscados/removidos.
-keep class org.nanohttpd.** { *; }
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
