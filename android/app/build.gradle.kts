plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Assinatura de release: senha vem de arquivo local gitignorado (keystore/.storepass), nunca do
// próprio build.gradle.kts — este arquivo é público. Sem o keystore (ex.: CI de fork), a release
// sai sem signingConfig — o gradle avisa e o APK não instala por cima de uma versão assinada.
val ksDir = file("$rootDir/keystore")
val ksFile = file("$ksDir/dsview-release.jks")
val ksPassFile = file("$ksDir/.storepass")
val hasSigning = ksFile.exists() && ksPassFile.exists()
val ksPass = if (hasSigning) ksPassFile.readText().trim() else ""

android {
    namespace = "com.dsview.player"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.dsview.player"
        minSdk = 21          // Android 5.0 — cobre TV boxes e Android TV antigos.
        targetSdk = 34
        versionCode = 17
        versionName = "0.6.1"
    }

    signingConfigs {
        if (hasSigning) {
            create("release") {
                storeFile = ksFile
                storePassword = ksPass
                keyAlias = "dsview"
                keyPassword = ksPass
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            if (hasSigning) signingConfig = signingConfigs.getByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

// Player single-source: copia player.js/player.css do plugin (../../ds-facil/player) para os assets no build.
// A cópia é gitignorada; nunca editar em app/src/main/assets — corrigir no plugin e rebuildar.
val copyPlayer by tasks.registering(Copy::class) {
    from("$rootDir/../../ds-facil/player") { include("player.js", "player.css") }
    into("$projectDir/src/main/assets")
    // O player vem do plugin com o cabeçalho da marca de origem. Este app é white-label, então
    // toda linha de comentário de bloco vira vazia na cópia — regra SEM ESTADO de propósito: o
    // filter do Gradle é por linha e a mesma closure roda para os dois arquivos, então qualquer
    // variável de controle vazaria de um para o outro. Também não citamos nome nenhum aqui,
    // porque este repositório é público. O código do player não tem marca fora dos comentários
    // (conferido: nenhuma linha de código começa com "*" nem fecha comentário sozinha).
    filter { linha: String ->
        val t = linha.trimStart()
        if (t.startsWith("/*") || t.startsWith("*")) "" else linha
    }
}
tasks.named("preBuild") { dependsOn(copyPlayer) }

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.webkit:webkit:1.11.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
    implementation("org.nanohttpd:nanohttpd:2.3.1")
    testImplementation("junit:junit:4.13.2")
    // Só em teste: o org.json que vem do SDK do Android é um STUB (método real lança "Stub!") — sem
    // isso, UpdaterTest não roda em JVM puro nenhuma linha que toque JSONObject/JSONArray. Mesma
    // implementação de referência que o Android usa por baixo, então o comportamento bate igual.
    testImplementation("org.json:json:20240303")
}
