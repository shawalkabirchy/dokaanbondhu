package com.dokaanbondhu.floatingmic

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.drawable.Icon
import android.os.Build
import android.os.IBinder
import android.util.Log

/**
 * The foreground service behind the bubble (spec 15.9): it owns the bubble's windows and keeps the app's process
 * allowed to use the microphone while another app is in front. Android 14 lets a microphone service start only while
 * the app is visible, so it starts from the app and is never restarted by the system (START_NOT_STICKY); the app
 * starts it again when it is opened with the switch on. Its notification, which Android requires, has a Stop button.
 */
class FloatingMicService : Service() {
  private var window: BubbleWindow? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_STOP) {
      FloatingMic.closedByUser(this)
      return START_NOT_STICKY
    }
    // Below Android 8 apps have no overlay window (the app offers no floating mic there).
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      stopSelf()
      return START_NOT_STICKY
    }
    val title = intent?.getStringExtra(EXTRA_TITLE).orEmpty()
    try {
      val notification =
        notification(
          intent?.getStringExtra(EXTRA_NAME) ?: title,
          title,
          intent?.getStringExtra(EXTRA_TEXT).orEmpty(),
          intent?.getStringExtra(EXTRA_STOP).orEmpty(),
        )
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
      } else {
        startForeground(NOTIFICATION_ID, notification)
      }
    } catch (error: Exception) {
      // For example started while the app was not in front: there is no bubble then.
      Log.w(TAG, "the floating mic could not start", error)
      FloatingMic.send("onClosed", mapOf("error" to (error.message ?: error.javaClass.simpleName)))
      stopSelf()
      return START_NOT_STICKY
    }
    if (window == null) {
      window = BubbleWindow(this, intent?.getStringExtra(EXTRA_HOLD) ?: title).also(FloatingMic::attach)
    }
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    window?.remove()
    window = null
    FloatingMic.detach()
    super.onDestroy()
  }

  private fun notification(name: String, title: String, text: String, stop: String): Notification {
    val manager = getSystemService(NotificationManager::class.java)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      manager.createNotificationChannel(NotificationChannel(CHANNEL, name, NotificationManager.IMPORTANCE_LOW))
    }
    val open = packageManager.getLaunchIntentForPackage(packageName)?.let {
      PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }
    val stopIntent = PendingIntent.getService(
      this,
      1,
      Intent(this, FloatingMicService::class.java).setAction(ACTION_STOP),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
    val builder =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) Notification.Builder(this, CHANNEL)
      else @Suppress("DEPRECATION") Notification.Builder(this)
    return builder
      .setSmallIcon(R.drawable.floating_mic_icon)
      .setContentTitle(title)
      .setContentText(text)
      .setOngoing(true)
      .setContentIntent(open)
      .addAction(Notification.Action.Builder(null as Icon?, stop, stopIntent).build())
      .build()
  }

  companion object {
    private const val TAG = "FloatingMic"
    private const val CHANNEL = "floating_mic"
    // Not 1: the audio library's own recording service uses 1.
    private const val NOTIFICATION_ID = 7301
    private const val ACTION_STOP = "com.dokaanbondhu.floatingmic.STOP"
    private const val EXTRA_NAME = "name"
    private const val EXTRA_TITLE = "title"
    private const val EXTRA_TEXT = "text"
    private const val EXTRA_STOP = "stop"
    private const val EXTRA_HOLD = "hold"

    fun start(context: Context, labels: Labels) {
      val intent =
        Intent(context, FloatingMicService::class.java)
          .putExtra(EXTRA_NAME, labels.name)
          .putExtra(EXTRA_TITLE, labels.title)
          .putExtra(EXTRA_TEXT, labels.text)
          .putExtra(EXTRA_STOP, labels.stop)
          .putExtra(EXTRA_HOLD, labels.hold)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent)
      else context.startService(intent)
    }

    fun stop(context: Context) {
      context.stopService(Intent(context, FloatingMicService::class.java))
    }
  }
}
