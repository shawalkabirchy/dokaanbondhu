package com.dokaanbondhu.floatingmic

import android.animation.ValueAnimator
import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.PixelFormat
import android.graphics.RectF
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.text.TextUtils
import android.util.Log
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.view.animation.LinearInterpolator
import android.widget.LinearLayout
import android.widget.TextView
import kotlin.math.hypot
import kotlin.math.min

// The app's colours (src/theme.ts).
private val GREEN = 0xFF1F7A4D.toInt()
private val GREEN_INK = 0xFF135233.toInt()
private val RED = 0xFFB3261E.toInt()
private val INK = 0xFF1B1F23.toInt()
private val LINE = 0xFFE0E5E8.toInt()
/** The talk button's colours while busy and while off (app/(app)/assistant.tsx). */
private val BUSY = 0xFFC9D6CF.toInt()
private val OFF = 0xFFD5DADE.toInt()
private val OFF_INK = 0xFF6B747C.toInt()

/** The window around the bubble, with room for the ring that grows with the voice. */
private const val BOX_DP = 84f
private const val CIRCLE_DP = 62f
private const val ICON_DP = 30f
private const val CLOSE_DP = 76f
/** How far a finger may move before a hold becomes a drag: held fingers wobble. */
private const val DRAG_DP = 24f
private const val CARD_TEXT_DP = 236f

/**
 * The bubble's windows over the other app (spec 15.9, D203): the round mic, the answer card beside it, and the close
 * target that shows while the mic is dragged. Hold the mic to talk and let go to send. Moving it more than a held
 * finger's wobble drags it instead and drops the recording, so nothing is sent; dropped on the × it switches the
 * floating mic off, otherwise it snaps to the nearest side and stays there next time. The vibration on press and
 * release is the bubble's own. A tap on the card's text opens the app; a write's card has the yes and no buttons.
 */
internal class BubbleWindow(private val context: Context, label: String) {
  private val density = context.resources.displayMetrics.density
  private val windows = context.getSystemService(WindowManager::class.java)
  private val prefs = context.getSharedPreferences("floating_mic", Context.MODE_PRIVATE)
  private val box = dp(BOX_DP)

  private val bubble = BubbleView(context, density).apply { contentDescription = label }
  private val bubbleParams =
    params(box, box).apply {
      x = prefs.getInt("x", screenWidth() - box)
      y = prefs.getInt("y", screenHeight() / 3)
    }

  private val cardText =
    TextView(context).apply {
      textSize = 16f
      setTextColor(INK)
      maxLines = 6
      ellipsize = TextUtils.TruncateAt.END
      maxWidth = dp(CARD_TEXT_DP)
      setLineSpacing(0f, 1.15f)
      setOnClickListener {
        dismissed = wanted
        removeCard()
        openApp()
      }
    }
  private val noButton = pill(filled = false)
  private val yesButton = pill(filled = true)
  private val buttons =
    LinearLayout(context).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.END
      setPadding(0, dp(10f), 0, 0)
      addView(noButton)
      addView(
        yesButton,
        LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT)
          .apply { marginStart = dp(8f) },
      )
    }
  private val card =
    LinearLayout(context).apply {
      orientation = LinearLayout.VERTICAL
      setPadding(dp(14f), dp(12f), dp(14f), dp(12f))
      background =
        GradientDrawable().apply {
          cornerRadius = dp(16f).toFloat()
          setColor(Color.WHITE)
          setStroke(dp(1f), LINE)
        }
      addView(cardText)
      addView(buttons)
    }
  private val cardParams = params(WindowManager.LayoutParams.WRAP_CONTENT, WindowManager.LayoutParams.WRAP_CONTENT)

  private val close = CloseView(context, density)
  private val closeParams =
    params(dp(CLOSE_DP), dp(CLOSE_DP)).apply {
      gravity = Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL
      y = dp(56f)
    }

  private var hidden = true
  private var bubbleShown = false
  private var cardShown = false
  private var closeShown = false
  /** The card the app asks for, and the one a tap put away (it stays away until the app asks for another). */
  private var wanted: Card? = null
  private var dismissed: Card? = null
  private var pressing = false
  private var dragging = false
  private var downX = 0f
  private var downY = 0f
  private var startX = 0
  private var startY = 0
  private var snap: ValueAnimator? = null

  init {
    bubble.setOnTouchListener { view, event -> onTouch(view, event) }
  }

  fun render(look: Look) {
    bubble.setLook(look.mode, look.level)
    wanted = look.card
    if (look.card != dismissed) dismissed = null
    updateCard()
  }

  /** Hidden while DokaanBondhu itself is open. */
  fun setHidden(hide: Boolean) {
    hidden = hide
    if (hide) {
      // Never left recording: a hold that is cut off is sent, as a release would be.
      if (pressing && !dragging) FloatingMic.send("onPressOut")
      pressing = false
      dragging = false
      removeView(bubble, bubbleShown)
      bubbleShown = false
      removeCard()
      removeClose()
    } else {
      if (!bubbleShown) bubbleShown = addView(bubble, bubbleParams)
      updateCard()
    }
  }

  fun remove() {
    snap?.cancel()
    setHidden(true)
  }

  @SuppressLint("ClickableViewAccessibility")
  private fun onTouch(view: View, event: MotionEvent): Boolean {
    when (event.actionMasked) {
      MotionEvent.ACTION_DOWN -> {
        snap?.cancel()
        downX = event.rawX
        downY = event.rawY
        startX = bubbleParams.x
        startY = bubbleParams.y
        pressing = true
        dragging = false
        view.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY)
        FloatingMic.send("onPressIn")
      }
      MotionEvent.ACTION_MOVE -> {
        val dx = event.rawX - downX
        val dy = event.rawY - downY
        if (!dragging && hypot(dx, dy) > dp(DRAG_DP)) {
          dragging = true
          FloatingMic.send("onCancel")
          removeCard()
          if (!closeShown) closeShown = addView(close, closeParams)
        }
        if (dragging) {
          bubbleParams.x = startX + dx.toInt()
          bubbleParams.y = startY + dy.toInt()
          moveBubble()
          close.over = overClose()
        }
      }
      MotionEvent.ACTION_UP,
      MotionEvent.ACTION_CANCEL -> {
        if (!pressing) return true
        pressing = false
        if (dragging) {
          dragging = false
          removeClose()
          if (overClose()) FloatingMic.closedByUser(context) else snapToSide()
        } else if (!FloatingMic.connected) {
          openApp() // the app's JavaScript is not listening: it is opened instead
        } else {
          view.performHapticFeedback(
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) HapticFeedbackConstants.VIRTUAL_KEY_RELEASE
            else HapticFeedbackConstants.VIRTUAL_KEY,
          )
          FloatingMic.send("onPressOut")
        }
      }
    }
    return true
  }

  private fun updateCard() {
    val shown = wanted
    if (shown == null || shown == dismissed || hidden || dragging || !bubbleShown) {
      removeCard()
      return
    }
    cardText.text = shown.text
    val actionId = shown.actionId
    if (actionId != null) {
      buttons.visibility = View.VISIBLE
      yesButton.text = shown.yes.orEmpty()
      noButton.text = shown.no.orEmpty()
      yesButton.setOnClickListener { decide(shown, actionId, "yes") }
      noButton.setOnClickListener { decide(shown, actionId, "no") }
    } else {
      buttons.visibility = View.GONE
    }
    placeCard()
    if (cardShown) updateView(card, cardParams) else cardShown = addView(card, cardParams)
  }

  private fun decide(shown: Card, actionId: String, decision: String) {
    dismissed = shown // one tap only; the reply to it brings the next card
    removeCard()
    FloatingMic.send("onDecide", mapOf("actionId" to actionId, "decision" to decision))
  }

  /** Beside the circle, on the side with the room; the window manager keeps it on the screen. */
  private fun placeCard() {
    val circle = dp(CIRCLE_DP)
    val gap = dp(6f)
    val onRight = bubbleParams.x + box / 2 > screenWidth() / 2
    cardParams.gravity = Gravity.TOP or if (onRight) Gravity.END else Gravity.START
    cardParams.x =
      if (onRight) screenWidth() - (bubbleParams.x + (box - circle) / 2) + gap
      else bubbleParams.x + (box + circle) / 2 + gap
    cardParams.y = bubbleParams.y + (box - circle) / 2
  }

  private fun snapToSide() {
    val target = if (bubbleParams.x + box / 2 < screenWidth() / 2) 0 else screenWidth() - box
    bubbleParams.y = bubbleParams.y.coerceIn(0, (screenHeight() - box).coerceAtLeast(0))
    snap =
      ValueAnimator.ofInt(bubbleParams.x, target).apply {
        duration = 160
        addUpdateListener {
          bubbleParams.x = it.animatedValue as Int
          moveBubble()
        }
        start()
      }
    prefs.edit().putInt("x", target).putInt("y", bubbleParams.y).apply()
  }

  private fun moveBubble() {
    if (bubbleShown) updateView(bubble, bubbleParams)
  }

  private fun overClose(): Boolean {
    val bubbleX = bubbleParams.x + box / 2f
    val bubbleY = bubbleParams.y + box / 2f
    val closeX = screenWidth() / 2f
    val closeY = screenHeight() - closeParams.y - dp(CLOSE_DP) / 2f
    return hypot(bubbleX - closeX, bubbleY - closeY) < dp(CLOSE_DP)
  }

  private fun openApp() {
    val intent = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return
    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED)
    context.startActivity(intent)
  }

  private fun removeCard() {
    removeView(card, cardShown)
    cardShown = false
  }

  private fun removeClose() {
    removeView(close, closeShown)
    closeShown = false
    close.over = false
  }

  private fun addView(view: View, params: WindowManager.LayoutParams): Boolean =
    try {
      windows.addView(view, params)
      true
    } catch (error: Exception) {
      // For example the permission to draw over other apps was taken back.
      Log.w("FloatingMic", "the bubble could not be shown", error)
      false
    }

  private fun updateView(view: View, params: WindowManager.LayoutParams) {
    try {
      windows.updateViewLayout(view, params)
    } catch (error: Exception) {
      Log.w("FloatingMic", "the bubble could not be moved", error)
    }
  }

  private fun removeView(view: View, shown: Boolean) {
    if (!shown) return
    try {
      windows.removeView(view)
    } catch (error: Exception) {
      Log.w("FloatingMic", "the bubble could not be removed", error)
    }
  }

  private fun params(width: Int, height: Int) =
    WindowManager.LayoutParams(
        width,
        height,
        WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
        // Not focusable, so touches outside the bubble and the card reach the app underneath.
        WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE,
        PixelFormat.TRANSLUCENT,
      )
      .apply { gravity = Gravity.TOP or Gravity.START }

  private fun pill(filled: Boolean) =
    TextView(context).apply {
      textSize = 16f
      typeface = Typeface.DEFAULT_BOLD
      gravity = Gravity.CENTER
      minHeight = dp(44f)
      minWidth = dp(88f)
      setPadding(dp(16f), 0, dp(16f), 0)
      setTextColor(if (filled) Color.WHITE else INK)
      background =
        GradientDrawable().apply {
          cornerRadius = dp(22f).toFloat()
          if (filled) {
            setColor(GREEN)
          } else {
            setColor(Color.WHITE)
            setStroke(dp(1f), LINE)
          }
        }
    }

  private fun screenWidth() = context.resources.displayMetrics.widthPixels

  private fun screenHeight() = context.resources.displayMetrics.heightPixels

  private fun dp(value: Float): Int = (value * density).toInt()
}

/**
 * The round mic: green when ready, red while listening with a ring that grows with the voice, pale with a turning arc
 * while working, green with a white arc while the speech worker wakes, green with a breathing ring while speaking, and
 * grey while offline (D203).
 */
@SuppressLint("ViewConstructor")
internal class BubbleView(context: Context, private val density: Float) : View(context) {
  private var mode = "ready"
  private var level = 0f
  private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
  private val edge =
    Paint(Paint.ANTI_ALIAS_FLAG).apply {
      style = Paint.Style.STROKE
      strokeWidth = 2 * density
      color = Color.WHITE
    }
  private val halo = Paint(Paint.ANTI_ALIAS_FLAG)
  private val arc =
    Paint(Paint.ANTI_ALIAS_FLAG).apply {
      style = Paint.Style.STROKE
      strokeWidth = 3 * density
      strokeCap = Paint.Cap.ROUND
    }
  private val icon = checkNotNull(context.getDrawable(R.drawable.floating_mic_icon)).mutate()
  private val oval = RectF()
  /** 0 to 1, over and over: the arc's turn and the speaking ring's breath. */
  private var phase = 0f
  private val animator =
    ValueAnimator.ofFloat(0f, 1f).apply {
      duration = 1200
      repeatCount = ValueAnimator.INFINITE
      interpolator = LinearInterpolator()
      addUpdateListener {
        phase = it.animatedValue as Float
        invalidate()
      }
    }

  fun setLook(next: String, loudness: Float) {
    if (next != mode) {
      mode = next
      if (moving() && isAttachedToWindow) animator.start() else animator.cancel()
    }
    level = loudness
    invalidate()
  }

  private fun moving() = mode == "working" || mode == "waking" || mode == "speaking"

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    if (moving()) animator.start()
  }

  override fun onDetachedFromWindow() {
    animator.cancel()
    super.onDetachedFromWindow()
  }

  override fun onDraw(canvas: Canvas) {
    val cx = width / 2f
    val cy = height / 2f
    val radius = CIRCLE_DP * density / 2f
    val room = width / 2f - radius
    when (mode) {
      "listening" -> {
        halo.color = 0x33B3261E
        canvas.drawCircle(cx, cy, radius + room * min(1f, level * 10f), halo)
      }
      "speaking" -> {
        halo.color = 0x331F7A4D
        val breath = if (phase < 0.5f) phase * 2 else (1 - phase) * 2
        canvas.drawCircle(cx, cy, radius + room * breath, halo)
      }
    }
    fill.color =
      when (mode) {
        "listening" -> RED
        "working" -> BUSY
        "off" -> OFF
        else -> GREEN
      }
    canvas.drawCircle(cx, cy, radius, fill)
    canvas.drawCircle(cx, cy, radius, edge)
    if (mode == "working" || mode == "waking") {
      arc.color = if (mode == "working") GREEN_INK else Color.WHITE
      val inset = 6 * density
      oval.set(cx - radius + inset, cy - radius + inset, cx + radius - inset, cy + radius - inset)
      canvas.drawArc(oval, phase * 360f, 90f, false, arc)
    }
    val half = ICON_DP * density / 2f
    icon.setBounds((cx - half).toInt(), (cy - half).toInt(), (cx + half).toInt(), (cy + half).toInt())
    icon.setTint(
      when (mode) {
        "working" -> GREEN_INK
        "off" -> OFF_INK
        else -> Color.WHITE
      },
    )
    icon.draw(canvas)
  }
}

/** The × the bubble is dropped on to switch the floating mic off; red while the bubble is over it. */
@SuppressLint("ViewConstructor")
internal class CloseView(context: Context, private val density: Float) : View(context) {
  var over = false
    set(value) {
      if (field != value) {
        field = value
        invalidate()
      }
    }
  private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
  private val cross =
    Paint(Paint.ANTI_ALIAS_FLAG).apply {
      style = Paint.Style.STROKE
      color = Color.WHITE
      strokeWidth = 3 * density
      strokeCap = Paint.Cap.ROUND
    }

  override fun onDraw(canvas: Canvas) {
    val cx = width / 2f
    val cy = height / 2f
    val radius = (if (over) 0.5f else 0.4f) * min(width, height)
    fill.color = if (over) RED else 0xCC1B1F23.toInt()
    canvas.drawCircle(cx, cy, radius, fill)
    val arm = radius * 0.38f
    canvas.drawLine(cx - arm, cy - arm, cx + arm, cy + arm, cross)
    canvas.drawLine(cx - arm, cy + arm, cx + arm, cy - arm, cross)
  }
}
