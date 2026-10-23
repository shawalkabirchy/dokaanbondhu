package com.dokaanbondhu.floatingmic

import android.content.Context
import android.os.Handler
import android.os.Looper
import com.facebook.react.ReactApplication
import com.facebook.react.bridge.Arguments
import com.facebook.react.jstasks.HeadlessJsTaskConfig
import com.facebook.react.jstasks.HeadlessJsTaskContext

/** How the bubble looks: its mode (ready, listening, working, waking, speaking, off), the voice's loudness while
 * listening, and the answer card beside it. */
internal data class Look(val mode: String, val level: Float, val card: Card?)

/** The answer card: its text, and for a write waiting for yes or no, the action and the two buttons' words. */
internal data class Card(val text: String, val actionId: String?, val yes: String?, val no: String?)

/**
 * What the module, the service and the bubble share; used on the main thread only. The JS task started here keeps
 * the app's timers running while another app is in front: React Native holds them while its Activity is paused,
 * unless a headless task is running, and push-to-talk needs them (the half second after the release, the wait for
 * the last chunk, the 30 s limit).
 */
internal object FloatingMic {
  /** The JS task's name, registered in src/lib/floating-mic.ts. */
  private const val TASK = "FloatingMicAwake"

  val main = Handler(Looper.getMainLooper())

  private var emit: ((String, Map<String, Any?>) -> Unit)? = null
  var bubble: BubbleWindow? = null
    private set
  private var look: Look? = null
  private var appInFront = true
  private var tasks: HeadlessJsTaskContext? = null
  private var taskId: Int? = null

  /** Whether the app's JavaScript can hear the bubble; without it a tap on the bubble only opens the app. */
  val connected: Boolean
    get() = emit != null

  fun connect(sender: ((String, Map<String, Any?>) -> Unit)?) {
    emit = sender
    if (sender == null) {
      letJsSleep()
      show(Look("off", 0f, null))
    }
  }

  fun send(name: String, body: Map<String, Any?> = emptyMap()) {
    emit?.invoke(name, body)
  }

  fun show(next: Look) {
    look = next
    bubble?.render(next)
  }

  fun setAppInFront(front: Boolean) {
    appInFront = front
    bubble?.setHidden(front)
  }

  fun attach(window: BubbleWindow) {
    bubble = window
    look?.let(window::render)
    window.setHidden(appInFront)
  }

  fun detach() {
    bubble = null
    letJsSleep()
  }

  /** Dropped on the close target or stopped from the notification: the app turns its switch off. */
  fun closedByUser(context: Context) {
    send("onClosed")
    FloatingMicService.stop(context)
  }

  fun keepJsAwake(context: Context) {
    if (taskId != null) return
    val react = (context.applicationContext as? ReactApplication)?.reactHost?.currentReactContext ?: return
    val running = HeadlessJsTaskContext.getInstance(react)
    tasks = running
    // No time limit, allowed while the app is in front: it lasts as long as the bubble does.
    taskId = running.startTask(HeadlessJsTaskConfig(TASK, Arguments.createMap(), 0, true))
  }

  fun letJsSleep() {
    val id = taskId ?: return
    tasks?.finishTask(id)
    taskId = null
    tasks = null
  }
}
