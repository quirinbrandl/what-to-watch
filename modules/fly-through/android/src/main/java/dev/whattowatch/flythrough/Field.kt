package dev.whattowatch.flythrough

import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlin.math.sqrt

/*
 * The wait screen's fly-through, without the drawing. Hundreds of posters drift
 * towards the viewer off a far wall of tiny posters (the user's own films). It
 * shows the search as it happens:
 *
 * - each film the engine finds comes out of the far wall with a thin accent edge;
 * - when the rating starts, every film being rated gathers in a loose cloud in the
 *   middle; as its predicted rating comes in it moves closer the better it is, and
 *   a film predicted below the feed's cutoff drifts back into the wall;
 * - when the search is done the flight stops and the cloud holds until the feed opens.
 *
 * Lengths are in dp; depth 1 is the focal plane.
 */

/** Poster size, as a share of the prototype's default: the "large" setting the user chose. */
const val SIZE = 1.3
const val ZN = 0.6 // nearest depth: a poster closer than this is past the viewer
const val ZF = 6.5 // the far wall
const val CY = 0.42 // the vanishing point, as a share of the height
private const val Z_FRONT = 1.55 // a film predicted at 5 stars
private const val Z_BACK = 3.6 // a film predicted at the cutoff
private const val Z_UNRATED = 3.0 // a film whose rating has not come in
private const val EDGE = 0.55 // how strongly a found film's edge shows

class Poster(
  var film: String, // poster path of a found film; "" for one of the user's own
  var own: Int, // which of the user's films, when `film` is ""
  val phase: Double,
) {
  var x = 0.0
  var y = 0.0
  var z = ZF
  var hold = false // in the cloud: moves to (tx, ty, tz) instead of flying
  var release = false // leaving the cloud for the wall
  var tx = 0.0
  var ty = 0.0
  var tz = 0.0
  var rate = 1.0
}

/** What the search has reported so far. */
class FieldInput(
  val found: List<String> = emptyList(), // poster paths of the films found, in order
  val finalists: List<String> = emptyList(), // poster paths of the films being rated, in the engine's order
  val verdicts: List<Pair<String, Double>> = emptyList(), // poster path and predicted rating, in the order they came in
  val done: Boolean = false, // the search is over
  val miss: Double = 3.0, // a film predicted below this is not in the feed
)

/** One poster to draw this frame. */
class Sprite {
  var film = ""
  var own = 0
  var x = 0.0 // centre
  var y = 0.0
  var w = 0.0
  var a = 0.0 // opacity
  var edge = 0.0 // opacity of the accent edge
}

fun clamp(x: Double, a: Double = 0.0, b: Double = 1.0): Double = if (x < a) a else if (x > b) b else x
fun lerp(a: Double, b: Double, x: Double): Double = a + (b - a) * x
fun ramp(t: Double, a: Double, b: Double): Double = clamp((t - a) / (b - a))
private fun out2(x: Double): Double = 1 - (1 - x) * (1 - x)

class Field(val W: Double, val H: Double, private var seed: Int = 13) {
  val F = W * 0.55 // focal length
  val PW = 0.46 * SIZE // poster width at depth 1
  var t = 0.0
  val ps = ArrayList<Poster>()
  private val queue = ArrayDeque<String>() // found films waiting for the next poster that comes off the wall
  private var found = 0 // how many of input.found have been queued
  private var verdicts = 0 // how many of input.verdicts have been applied
  val cloud = LinkedHashMap<String, Int>() // poster path -> index in ps
  var judgeAt = -1.0 // when the rating started (-1: not yet)
  var doneAt = -1.0 // when the search finished (-1: not yet)
  private var order = IntArray(0) // indices into ps, back to front as of the last frame
  private var ordered = 0
  val out = ArrayList<Sprite>() // this frame's sprites: the first `sprites()` of them count

  init {
    val n = (520 / (SIZE * SIZE)).roundToInt()
    for (i in 0 until n) {
      val p = poster("")
      place(p, ZN + rnd() * (ZF - ZN), false)
      ps.add(p)
    }
  }

  /** mulberry32, so a run can be replayed. */
  private fun rnd(): Double {
    seed += 0x6d2b79f5
    var t = seed
    t = (t xor (t ushr 15)) * (t or 1)
    t = t xor (t + (t xor (t ushr 7)) * (t or 61))
    return ((t xor (t ushr 14)).toLong() and 0xffffffffL).toDouble() / 4294967296.0
  }

  /** Puts a poster at depth z where it shows at screen point (sx, sy). */
  private fun at(p: Poster, z: Double, sx: Double, sy: Double) {
    p.z = z
    p.x = ((sx - W / 2) * z) / F
    p.y = ((sy - H * CY) * z) / F
  }

  /** Puts a poster at depth z anywhere on screen, or (plain) where it is in plain view. */
  private fun place(p: Poster, z: Double, plain: Boolean) {
    val u = if (plain) 0.14 + rnd() * 0.72 else rnd() * 1.1 - 0.05
    val v = if (plain) 0.14 + rnd() * 0.48 else rnd() * 1.1 - 0.05
    at(p, z, u * W, v * H)
  }

  private fun poster(film: String): Poster {
    val own = floor(rnd() * 1e6).toInt()
    return Poster(film, own, rnd() * 6.28)
  }

  private fun gone(p: Poster): Boolean {
    val k = F / p.z
    val x = W / 2 + p.x * k
    val y = H * CY + p.y * k
    val w = PW * k
    return x < -w || x > W + w || y < -w * 1.5 || y > H + w * 1.5
  }

  /** How fast the flight goes: speeds up at the start, slows while rating, stops at the end. */
  fun speed(): Double {
    var v = lerp(0.45, 0.85, ramp(t, 0.0, 3.0))
    if (judgeAt >= 0) v = lerp(v, 0.22, out2(ramp(t, judgeAt, judgeAt + 1.8)))
    if (doneAt >= 0) v = lerp(v, 0.0, ramp(t, doneAt, doneAt + 0.4))
    return v
  }

  /** A poster that has passed the viewer or left the screen comes off the far wall again: a found film if one is waiting. */
  private fun respawn(p: Poster, i: Int) {
    if (p.film.isNotEmpty() && cloud[p.film] == i) cloud.remove(p.film)
    p.hold = false
    p.release = false
    if (queue.isNotEmpty() && judgeAt < 0) {
      p.film = queue.removeFirst()
      place(p, ZF, true)
    } else {
      p.film = ""
      p.own = floor(rnd() * 1e6).toInt()
      place(p, ZF, false)
    }
  }

  /** Where a film sits in the cloud: its own spot on a spiral, closer to the viewer the better its rating. */
  private fun aim(p: Poster, n: Int, count: Int, r: Double?, miss: Double, rate: Double) {
    val back = if (r == null) 0.7 else clamp((5 - r) / (5 - miss))
    val tz = if (r == null) Z_UNRATED else lerp(Z_FRONT, Z_BACK, back)
    val a = n * 2.39996
    // The spots stay where they are: many films get 4.5 or 5 stars, and pulling them all to the middle piles them up.
    val rr = sqrt((n + 0.5) / max(1, count)) * lerp(0.85, 1.0, back)
    val sx = W / 2 + cos(a) * rr * W * 0.46
    val sy = H * 0.37 + sin(a) * rr * H * 0.28
    p.tx = ((sx - W / 2) * tz) / F
    p.ty = ((sy - H * CY) * tz) / F
    p.tz = tz
    p.rate = rate
  }

  /** A film joins the cloud: the poster of it that is flying in view, or a new one out of the wall. */
  private fun join(film: String, n: Int, count: Int, r: Double?, miss: Double) {
    var i = ps.indexOfFirst { it.film == film && !it.hold && it.z > 1 && !gone(it) }
    if (i < 0) {
      val p = poster(film)
      place(p, ZF, true)
      ps.add(p)
      i = ps.size - 1
    }
    val p = ps[i]
    p.hold = true
    p.release = false
    cloud[film] = i
    aim(p, n, count, r, miss, 0.8)
  }

  /** Not in the feed: back into the wall, straight behind where it is. */
  private fun release(p: Poster) {
    p.release = true
    val k = (ZF + 0.6) / p.z
    p.tx = p.x * k
    p.ty = p.y * k
    p.tz = ZF + 0.6
    p.rate = 0.75
  }

  /** Moves everything on by dt seconds, taking in what the search reported. */
  fun step(input: FieldInput, dt: Double) {
    t += dt
    // The engine started over: the cloud goes back into the wall.
    if (judgeAt >= 0 && input.finalists.isEmpty()) {
      for (i in cloud.values) release(ps[i])
      cloud.clear()
      judgeAt = -1.0
      verdicts = 0
    }
    if (input.verdicts.size < verdicts) verdicts = 0
    while (found < input.found.size) queue.addLast(input.found[found++])
    val count = input.finalists.size
    if (judgeAt < 0 && count > 0) {
      judgeAt = t
      queue.clear()
      val rated = HashMap<String, Double>()
      for ((film, r) in input.verdicts) rated[film] = r
      input.finalists.forEachIndexed { n, film ->
        val r = rated[film]
        if (r == null || r >= input.miss) join(film, n, count, r, input.miss)
      }
      verdicts = input.verdicts.size
    }
    while (verdicts < input.verdicts.size) {
      val (film, r) = input.verdicts[verdicts++]
      val n = input.finalists.indexOf(film)
      if (n < 0) continue
      val i = cloud[film]
      if (r < input.miss) {
        if (i != null) {
          release(ps[i])
          cloud.remove(film)
        }
      } else if (i != null) aim(ps[i], n, count, r, input.miss, 1.1)
      else join(film, n, count, r, input.miss)
    }
    if (input.done && doneAt < 0) doneAt = t

    val v = speed()
    for (i in ps.indices) {
      val p = ps[i]
      if (p.hold || p.release) {
        val k = 1 - exp(-dt * p.rate)
        p.x += (p.tx - p.x) * k
        p.y += (p.ty - p.y) * k
        p.z += (p.tz - p.z) * k
        if (p.release && p.z > ZF - 0.25) respawn(p, i)
        continue
      }
      p.z -= v * dt
      if (p.z < ZN || gone(p)) respawn(p, i)
    }
  }

  /** Puts the posters to draw this frame into `out`, back to front, and returns how many there are. */
  fun sprites(): Int {
    if (order.size < ps.size) order = order.copyOf(ps.size + 64)
    while (ordered < ps.size) order[ordered] = ordered++
    // The order barely changes between frames (the flight moves every poster at the same speed),
    // so an insertion sort of last frame's order costs about one pass.
    for (i in 1 until ordered) {
      val v = order[i]
      val z = ps[v].z
      var j = i - 1
      while (j >= 0 && (ps[order[j]].z < z || (ps[order[j]].z == z && order[j] > v))) {
        order[j + 1] = order[j]
        j--
      }
      order[j + 1] = v
    }
    var n = 0
    val intro = ramp(t, 0.0, 0.8)
    // Once the search is done the flight steps back a little; the cloud stays as it is.
    val dim = if (doneAt >= 0) 1 - 0.5 * ramp(t, doneAt, doneAt + 0.5) else 1.0
    // While the cloud hovers in front, flying posters that come too close dissolve before they cover it.
    val clear = if (judgeAt >= 0) ramp(t, judgeAt, judgeAt + 1.5) else 0.0
    for (o in 0 until ordered) {
      val p = ps[order[o]]
      val k = F / p.z
      var x = W / 2 + p.x * k
      var y = H * CY + p.y * k
      val w = PW * k
      val h = w * 1.5
      if (p.hold) {
        x += sin(t * 0.7 + p.phase) * 3
        y += cos(t * 0.55 + p.phase) * 3
      }
      if (x + w < 0 || x - w > W || y + h < 0 || y - h > H) continue
      val near = if (p.hold) ZN + 0.45 else lerp(ZN + 0.45, 2.3, clear)
      val fog = ramp(p.z, ZN, near) * (1 - ramp(p.z, ZF - 1.4, ZF))
      val a = fog * intro * (if (p.hold && !p.release) 1.0 else dim)
      if (a <= 0.01) continue
      if (n == out.size) out.add(Sprite())
      val s = out[n++]
      s.film = p.film
      s.own = p.own
      s.x = x
      s.y = y
      s.w = w
      s.a = a
      s.edge = if (p.film.isNotEmpty()) EDGE * a else 0.0
    }
    return n
  }

  /** The far wall: how strongly it shows (wallAlpha) and how far it has come closer (wallScale). */
  fun wallAlpha(): Double {
    val dim = if (doneAt >= 0) 1 - 0.5 * ramp(t, doneAt, doneAt + 0.5) else 1.0
    return ramp(t, 0.0, 0.8) * 0.4 * dim
  }

  fun wallScale(): Double = 1 + 0.003 * min(t, 60.0)
}
