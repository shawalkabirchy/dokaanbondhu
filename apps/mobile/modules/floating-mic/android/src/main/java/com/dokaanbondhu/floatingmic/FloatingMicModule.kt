package com.dokaanbondhu.floatingmic

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record

// The floating mic's module (spec 15.9, D196, D203): the app switches the bubble on and off, tells it how to look,
// and hears its presses. The recording, the upload and the answer stay in the app's JavaScript, exactly as on the
// assistant page; the bubble only draws and reports touches.

/** The notification's channel name and words, and the bubble's spoken label, in the app's language. */
class Labels : Record {
  @Field val name: String = ""
  @Field val title: String = ""
  @Field val text: String = ""
  @Field val stop: String = ""
  @Field val hold: String = ""
}

class CardRecord : Record {
  @Field val text: String = ""
  @Field val actionId: String? = null
  @Field val yes: String? = null
  @Field val no: String? = null
}

class LookRecord : Record {
  @Field val mode: String = "ready"
  @Field val level: Double = 0.0
  @Field val card: CardRecord? = null
}

class FloatingMicModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("FloatingMic")

    Events("onPressIn", "onPressOut", "onCancel", "onDecide", "onClosed")

    OnCreate { FloatingMic.connect { name, body -> sendEvent(name, body) } }

    OnDestroy { FloatingMic.main.post { FloatingMic.connect(null) } }

    // Below Android 8 there is no overlay window type for apps.
    Function("isSupported") { Build.VERSION.SDK_INT >= Build.VERSION_CODES.O }

    Function("canDrawOverlays") { Settings.canDrawOverlays(context) }

    Function("openOverlaySettings") {
      val intent =
        Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:${context.packageName}"))
          .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      context.startActivity(intent)
    }

    Function("isRunning") { FloatingMic.bubble != null }

    // Only while the app is in front: Android 14 lets a microphone service start only then.
    AsyncFunction("start") { labels: Labels ->
      if (!Settings.canDrawOverlays(context)) throw CodedException("NO_OVERLAY", "Drawing over other apps is not allowed", null)
      if (context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED)
        throw CodedException("NO_MICROPHONE", "The microphone is not allowed", null)
      FloatingMicService.start(context, labels)
      FloatingMic.keepJsAwake(context)
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("stop") {
      FloatingMic.letJsSleep()
      FloatingMicService.stop(context)
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("update") { look: LookRecord ->
      val card = look.card
      FloatingMic.show(
        Look(
          look.mode,
          look.level.toFloat(),
          if (card == null) null else Card(card.text, card.actionId, card.yes, card.no),
        ),
      )
    }.runOnQueue(Queues.MAIN)

    // The bubble hides while DokaanBondhu itself is open, so there is one mic at a time.
    OnActivityEntersForeground { FloatingMic.main.post { FloatingMic.setAppInFront(true) } }

    OnActivityEntersBackground { FloatingMic.main.post { FloatingMic.setAppInFront(false) } }
  }
}
