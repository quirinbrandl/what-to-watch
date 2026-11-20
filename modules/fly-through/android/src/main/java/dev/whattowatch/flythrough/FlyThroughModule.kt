package dev.whattowatch.flythrough

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class FlyThroughModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("FlyThrough")

    View(FlyThroughView::class) {
      Prop("own") { view, own: List<String> -> view.own = own }
      Prop("found") { view, found: List<String> -> view.found = found }
      Prop("finalists") { view, finalists: List<String> -> view.finalists = finalists }
      Prop("verdictFilms") { view, films: List<String> -> view.verdictFilms = films }
      Prop("verdictStars") { view, stars: DoubleArray -> view.verdictStars = stars }
      Prop("done") { view, done: Boolean -> view.done = done }
      Prop("miss") { view, miss: Double -> view.miss = miss }
      Prop("seed") { view, seed: Int -> view.seed = seed }
      OnViewDidUpdateProps { view -> view.propsChanged() }
    }
  }
}
