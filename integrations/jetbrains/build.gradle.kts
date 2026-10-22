import groovy.json.JsonSlurper
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("org.jetbrains.kotlin.jvm")
    id("org.jetbrains.intellij.platform")
}

// One version for every Styled Markdown artifact: the extension's (extension/package.json).
val repoRoot: File = rootDir.resolve("../..").normalize()
val smdVersion = (JsonSlurper().parse(repoRoot.resolve("extension/package.json")) as Map<*, *>)["version"] as String

group = "com.bislink360"
version = smdVersion

// IntelliJ Platform 2025.1+ runs on Java 21. Compile for it with whatever JDK runs Gradle (21 or newer).
java {
    sourceCompatibility = JavaVersion.VERSION_21
    targetCompatibility = JavaVersion.VERSION_21
}
kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_21)
        freeCompilerArgs.add("-Xjdk-release=21")
    }
}

repositories {
    mavenCentral()
    intellijPlatform {
        defaultRepositories()
    }
}

dependencies {
    intellijPlatform {
        // -PlocalIde=<folder> builds against an installed IDE instead of downloading one.
        val localIde = providers.gradleProperty("localIde").orNull
        if (localIde != null) local(localIde) else intellijIdea(providers.gradleProperty("platformVersion"))
        bundledPlugin("org.jetbrains.plugins.textmate")
    }
}

intellijPlatform {
    // No forms to instrument, and no settings search index to build (it starts a headless IDE).
    instrumentCode = false
    buildSearchableOptions = false
    pluginConfiguration {
        version = smdVersion
        ideaVersion {
            sinceBuild = "251"
            untilBuild = provider { null }
        }
    }
}

// What the plugin ships besides its jar: the language server (the self-contained `smd` CLI the agent
// skills bundle, identical to extension/dist/cli.js) and the TextMate bundle in bundle/: the VS Code
// extension's grammar made into one file (scripts/bundle-grammar.mjs; a unit test checks it is up to
// date) and its own copy of the Markdown grammar, so the highlighting is the extension's.
val pluginFolder = rootProject.name // the plugin's folder in the sandbox and the zip

tasks.prepareSandbox {
    from(repoRoot.resolve("skills/styled-markdown-reader/scripts/smd.cjs")) {
        into("$pluginFolder/server")
    }
    from(layout.projectDirectory.dir("bundle")) {
        into("$pluginFolder/bundle")
    }
    from(repoRoot.resolve("extension/language-configuration.json")) {
        into("$pluginFolder/bundle")
    }
}
