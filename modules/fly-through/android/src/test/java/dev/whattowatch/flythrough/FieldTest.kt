package dev.whattowatch.flythrough

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class FieldTest {
  private fun run(f: Field, input: FieldInput, secs: Double) {
    var t = 0.0
    while (t < secs) {
      f.step(input, 1 / 30.0)
      t += 1 / 30.0
    }
  }

  @Test
  fun foundFilmsComeOffTheFarWallIntoTheFlight() {
    val f = Field(400.0, 860.0)
    run(f, FieldInput(), 2.0)
    assertTrue("at first only the user's own films fly", f.ps.size > 200 && f.ps.all { it.film == "" })
    val found = (0 until 20).map { "/found$it.jpg" }
    run(f, FieldInput(found = found), 0.5)
    assertEquals("every found film is in the flight", 20, f.ps.filter { it.film != "" }.map { it.film }.toSet().size)
    val n = f.sprites()
    assertTrue("found films carry the accent edge", f.out.take(n).any { it.film != "" && it.edge > 0 })
  }

  @Test
  fun theRatedFilmsGatherTheBetterOnesInFront() {
    val f = Field(400.0, 860.0)
    val finalists = (0 until 30).map { "/f$it.jpg" }
    val stars = listOf(2.0, 3.0, 4.0, 5.0, 2.5, 3.5)
    run(f, FieldInput(found = finalists, finalists = finalists), 3.0)
    assertEquals("every film being rated is in the cloud", 30, f.cloud.size)
    assertTrue("the flight slows down while rating", f.speed() < 0.3)
    val verdicts = finalists.mapIndexed { i, film -> film to stars[i % 6] }
    val input = FieldInput(found = finalists, finalists = finalists, verdicts = verdicts)
    run(f, input, 12.0)
    val kept = finalists.filterIndexed { i, _ -> stars[i % 6] >= 3.0 }.toSet()
    assertEquals("only the films that make the feed stay", kept, f.cloud.keys)
    val depth = { film: String -> f.ps[f.cloud[film]!!].z }
    assertTrue("5 stars in front of 4, 4 in front of 3", depth("/f3.jpg") < depth("/f2.jpg") && depth("/f2.jpg") < depth("/f1.jpg"))
    assertTrue("a 2-star film has left the cloud", f.ps.none { it.film == "/f0.jpg" && it.hold })

    // The search is done: the flight stops, the cloud holds.
    run(f, FieldInput(found = finalists, finalists = finalists, verdicts = verdicts, done = true), 1.0)
    assertEquals(0.0, f.speed(), 0.0)
    assertEquals(kept, f.cloud.keys)
  }
}
