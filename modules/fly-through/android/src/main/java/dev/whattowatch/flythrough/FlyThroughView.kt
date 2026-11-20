package dev.whattowatch.flythrough

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RadialGradient
import android.graphics.RectF
import android.graphics.Shader
import android.view.Choreographer
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.views.ExpoView
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import kotlin.math.floor
import kotlin.math.hypot
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sin

private const val OWN_W = 154 // the user's films are drawn small or pass by quickly
private const val OWN_H = 231
private const val FOUND_W = 256 // found films can come to the front of the cloud
private const val FOUND_H = 384
private const val IMG = "https://image.tmdb.org/t/p/"

/**
 * Draws the fly-through (see Field.kt) with Android's own renderer. It used to be drawn with
 * React Native Skia from a worklet, which on a phone took longer than a frame: every poster,
 * every frame, crossed from JavaScript to native code. Here the simulation runs in Kotlin on
 * the UI thread and the drawing is recorded in well under a millisecond; the GPU work happens
 * on the render thread. JavaScript only passes in what the search reports.
 */
class FlyThroughView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  // Props
  var own: List<String> = emptyList()
  var found: List<String> = emptyList()
  var finalists: List<String> = emptyList()
  var verdictFilms: List<String> = emptyList()
  var verdictStars: DoubleArray = DoubleArray(0)
  var done = false
  var miss = 3.0
  var seed = 13

  private val density = resources.displayMetrics.density
  private var field: Field? = null
  private var input = FieldInput()
  private var running = false
  private var last = -1L
  private val frame = Choreographer.FrameCallback { now -> onFrame(now) }

  private var loader: ExecutorService? = null
  private var ownList: List<String> = emptyList()
  private var owns: Array<Bitmap?> = arrayOfNulls(0)
  private val films = HashMap<String, Bitmap>()
  private val asked = HashSet<String>()
  private var wall: Bitmap? = null
  private var walled = -1

  private val paint = Paint(Paint.FILTER_BITMAP_FLAG or Paint.ANTI_ALIAS_FLAG)
  private val halo = stroke(6f)
  private val line = stroke(1.8f)
  private val glow = Paint()
  private val shade = Paint()
  private val dst = RectF()
  private val ACCENT = Color.rgb(255, 77, 46)
  private val BG = Color.rgb(10, 9, 8)

  init {
    setWillNotDraw(false)
  }

  private fun stroke(width: Float) = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    style = Paint.Style.STROKE
    strokeWidth = width
  }

  /** After a batch of prop changes. */
  fun propsChanged() {
    val verdicts = verdictFilms.indices.filter { it < verdictStars.size }.map { verdictFilms[it] to verdictStars[it] }
    input = FieldInput(found, finalists, verdicts, done, miss)
    if (own != ownList) loadOwn(own)
    for (p in finalists + found) {
      if (asked.add(p)) load(p, "w342", FOUND_W, FOUND_H) { films[p] = it }
    }
  }

  /* ---- The frame loop ---- */

  override fun onVisibilityAggregated(isVisible: Boolean) {
    super.onVisibilityAggregated(isVisible)
    if (isVisible) start() else stop()
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    if (isShown) start()
  }

  override fun onDetachedFromWindow() {
    stop()
    loader?.shutdownNow()
    loader = null
    films.clear()
    asked.clear()
    ownList = emptyList()
    super.onDetachedFromWindow()
  }

  private fun start() {
    if (running) return
    running = true
    last = -1L
    Choreographer.getInstance().postFrameCallback(frame)
  }

  private fun stop() {
    running = false
    Choreographer.getInstance().removeFrameCallback(frame)
  }

  private fun onFrame(now: Long) {
    if (!running) return
    val W = width / density.toDouble()
    val H = height / density.toDouble()
    if (W > 0 && H > 0) {
      var f = field
      if (f == null || f.W != W || f.H != H) {
        f = Field(W, H, seed)
        field = f
        glow.shader = RadialGradient((W / 2).toFloat(), (H * CY).toFloat(), (W * 0.7).toFloat(), Color.argb(36, 255, 77, 46), Color.argb(0, 255, 77, 46), Shader.TileMode.CLAMP)
        shade.shader = RadialGradient((W / 2).toFloat(), (H / 2).toFloat(), (hypot(W, H) / 2).toFloat(), intArrayOf(Color.argb(0, 0, 0, 0), Color.argb(128, 0, 0, 0)), floatArrayOf(0.4f, 1f), Shader.TileMode.CLAMP)
        walled = -1
        buildWall()
      }
      val dt = if (last < 0) 0.0 else min(0.05, (now - last) / 1e9)
      f.step(input, dt)
      invalidate()
    }
    last = now
    Choreographer.getInstance().postFrameCallback(frame)
  }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    val f = field ?: return
    val W = f.W.toFloat()
    val H = f.H.toFloat()
    canvas.save()
    canvas.scale(density, density)
    canvas.drawColor(BG)
    wall?.let { img ->
      val scale = f.wallScale().toFloat()
      val w = W * 1.2f * scale
      val h = H * 1.2f * scale
      dst.set(W / 2 - w / 2, H * CY.toFloat() - h / 2, W / 2 + w / 2, H * CY.toFloat() + h / 2)
      paint.alpha = alpha(f.wallAlpha())
      canvas.drawBitmap(img, null, dst, paint)
    }
    canvas.drawRect(0f, 0f, W, H, glow)
    val n = f.sprites()
    val count = owns.size
    for (i in 0 until n) {
      val s = f.out[i]
      val img = if (s.film.isNotEmpty()) films[s.film] else if (count > 0) owns[s.own % count] else null
      if (img == null) continue
      val w = s.w.toFloat()
      val h = w * 1.5f
      val x = s.x.toFloat() - w / 2
      val y = s.y.toFloat() - h / 2
      dst.set(x, y, x + w, y + h)
      paint.alpha = alpha(s.a)
      canvas.drawBitmap(img, null, dst, paint)
      if (s.edge > 0.01) {
        // A thin accent frame with a soft glow.
        halo.color = ACCENT
        halo.alpha = alpha(s.edge * 0.35)
        canvas.drawRect(x - 1, y - 1, x + w + 1, y + h + 1, halo)
        line.color = ACCENT
        line.alpha = alpha(s.edge)
        canvas.drawRect(x, y, x + w, y + h, line)
      }
    }
    canvas.drawRect(0f, 0f, W, H, shade)
    canvas.restore()
  }

  private fun alpha(a: Double) = (a * 255).roundToInt().coerceIn(0, 255)

  /* ---- Posters ---- */

  /** Fetches a poster on a loader thread and scales it to the size it is drawn at; `done` runs on the UI thread. */
  private fun load(path: String, size: String, w: Int, h: Int, done: (Bitmap) -> Unit) {
    // Made here, not when the view is attached: the props (and with them the first loads) come before that.
    val pool = loader ?: Executors.newFixedThreadPool(6).also { loader = it }
    pool.execute {
      val img = try {
        fetch(IMG + size + path, w, h)
      } catch (e: Exception) {
        null // A poster that does not load is left out.
      }
      if (img != null) post { if (loader === pool) done(img) }
    }
  }

  private fun fetch(url: String, w: Int, h: Int): Bitmap? {
    val c = URL(url).openConnection() as HttpURLConnection
    c.connectTimeout = 15000
    c.readTimeout = 15000
    try {
      val src = c.inputStream.use { BitmapFactory.decodeStream(it) } ?: return null
      val img = Bitmap.createScaledBitmap(src, w, h, true)
      if (img !== src) src.recycle()
      img.setHasMipMap(true)
      img.prepareToDraw()
      return img
    } finally {
      c.disconnect()
    }
  }

  /** The user's films: whatever is cached shows at once, the rest as it comes in. */
  private fun loadOwn(list: List<String>) {
    ownList = list
    owns = Array(list.size) { ownCache[list[it]] }
    walled = -1
    buildWall()
    list.forEachIndexed { i, p ->
      if (owns[i] != null) return@forEachIndexed
      load(p, "w185", OWN_W, OWN_H) { img ->
        if (ownCache.size > 240) ownCache.remove(ownCache.keys.first())
        ownCache[p] = img
        if (ownList === list) {
          owns[i] = img
          laterWall()
        }
      }
    }
  }

  private val wallTask = Runnable { buildWall() }

  private fun laterWall() {
    removeCallbacks(wallTask)
    postDelayed(wallTask, 250)
  }

  /** The far wall is redrawn a few times while the posters come in, then once more when all are there. */
  private fun buildWall() {
    val f = field ?: return
    val ready = owns.filterNotNull()
    val all = ready.size == owns.size
    if (ready.isEmpty() || (if (all) walled == ready.size else walled >= 0 && ready.size - walled < 30)) return
    walled = ready.size
    val list = ownList
    val W = f.W
    val H = f.H
    painter.execute {
      val img = farWall(W, H, ready)
      post { if (ownList === list && field?.W == W && field?.H == H) wall = img }
    }
  }

  companion object {
    /** The user's films stay decoded between searches (used on the UI thread only). */
    private val ownCache = LinkedHashMap<String, Bitmap>()

    /** Draws the far wall, away from the poster downloads. */
    private val painter = Executors.newSingleThreadExecutor()

    private fun hash(n: Double): Double {
      val x = sin(n * 127.1 + 311.7) * 43758.5453
      return x - floor(x)
    }

    /** The far wall: tiny posters of the user's films, drawn once. */
    private fun farWall(W: Double, H: Double, imgs: List<Bitmap>): Bitmap {
      val S = 2f // pixels per dp: it is drawn faint and small
      val ww = W * 1.2
      val wh = H * 1.2
      val img = Bitmap.createBitmap((ww * S).roundToInt(), (wh * S).roundToInt(), Bitmap.Config.ARGB_8888)
      val c = Canvas(img)
      c.scale(S, S)
      c.drawColor(Color.rgb(10, 9, 8))
      val paint = Paint(Paint.FILTER_BITMAP_FLAG or Paint.ANTI_ALIAS_FLAG)
      val cols = (22 / SIZE).roundToInt()
      val tw = ww / cols
      val th = tw * 1.5
      val r = RectF()
      for (col in 0 until cols) {
        var row = 0
        while (row * th < wh) {
          val p = imgs[floor(hash(col * 3.3 + row * 17.9) * imgs.size).toInt()]
          r.set((col * tw + 0.6).toFloat(), (row * th + 0.6).toFloat(), (col * tw + tw - 0.6).toFloat(), (row * th + th - 0.6).toFloat())
          c.drawBitmap(p, null, r, paint)
          row++
        }
      }
      img.prepareToDraw()
      return img
    }
  }
}
