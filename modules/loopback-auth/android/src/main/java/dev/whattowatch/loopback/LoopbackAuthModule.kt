package dev.whattowatch.loopback

import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URLDecoder
import kotlin.concurrent.thread

/**
 * A one-shot HTTP listener on 127.0.0.1 that receives the OAuth redirect of
 * "Sign in with ChatGPT". It runs on its own native thread, so it keeps
 * working while the app sits behind the browser.
 */
class LoopbackAuthModule : Module() {
  private val lock = Any()
  private var server: ServerSocket? = null
  private var result: String? = null
  private var waiter: Promise? = null

  override fun definition() = ModuleDefinition {
    Name("LoopbackAuth")

    // Starts listening on a free port and returns it.
    AsyncFunction("start") { path: String, state: String, okHtml: String, failHtml: String ->
      stopServer()
      val socket = ServerSocket(0, 8, InetAddress.getByName("127.0.0.1"))
      synchronized(lock) {
        server = socket
        result = null
      }
      thread(name = "loopback-auth", isDaemon = true) { serve(socket, path, state, okHtml, failHtml) }
      socket.localPort
    }

    // Resolves with the query string of the callback request.
    AsyncFunction("wait") { promise: Promise ->
      synchronized(lock) {
        val r = result
        when {
          r != null -> promise.resolve(r)
          server == null -> promise.reject("ERR_LOOPBACK_STOPPED", "The listener is not running", null)
          else -> {
            waiter?.reject("ERR_LOOPBACK_STOPPED", "Superseded", null)
            waiter = promise
          }
        }
      }
    }

    Function("stop") { stopServer() }

    OnDestroy { stopServer() }
  }

  private fun stopServer() {
    val (socket, pending) = synchronized(lock) {
      val s = server
      val w = waiter
      server = null
      waiter = null
      Pair(s, w)
    }
    try {
      socket?.close()
    } catch (_: Exception) {
    }
    pending?.reject("ERR_LOOPBACK_STOPPED", "The listener was stopped", null)
  }

  private fun serve(socket: ServerSocket, path: String, state: String, okHtml: String, failHtml: String) {
    try {
      while (!socket.isClosed) {
        val client = socket.accept()
        try {
          handle(client, path, state, okHtml, failHtml)
        } catch (_: Exception) {
        } finally {
          try {
            client.close()
          } catch (_: Exception) {
          }
        }
      }
    } catch (_: Exception) {
      // Socket closed: we are done.
    }
  }

  private fun handle(client: Socket, path: String, state: String, okHtml: String, failHtml: String) {
    client.soTimeout = 5000
    val reader = BufferedReader(InputStreamReader(client.getInputStream(), Charsets.ISO_8859_1))
    val requestLine = reader.readLine() ?: return
    while (true) {
      val line = reader.readLine() ?: break
      if (line.isEmpty()) break
    }
    val parts = requestLine.split(" ")
    if (parts.size < 2 || parts[0] != "GET") return respond(client, "405 Method Not Allowed", "")
    val target = parts[1]
    val cut = target.indexOf('?')
    val query = if (cut >= 0) target.substring(cut + 1) else ""
    if ((if (cut >= 0) target.substring(0, cut) else target) != path) return respond(client, "404 Not Found", "")
    val params = HashMap<String, String>()
    for (pair in query.split("&")) {
      val eq = pair.indexOf('=')
      if (eq <= 0) continue
      try {
        params[URLDecoder.decode(pair.substring(0, eq), "UTF-8")] = URLDecoder.decode(pair.substring(eq + 1), "UTF-8")
      } catch (_: Exception) {
      }
    }
    val ok = params["error"] == null && params["state"] == state
    respond(client, "200 OK", if (ok) okHtml else failHtml)
    synchronized(lock) {
      if (result == null) {
        result = query
        waiter?.resolve(query)
        waiter = null
      }
    }
  }

  private fun respond(client: Socket, status: String, html: String) {
    val body = html.toByteArray(Charsets.UTF_8)
    val head = "HTTP/1.1 $status\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: ${body.size}\r\n" +
      "Cache-Control: no-store\r\nConnection: close\r\n\r\n"
    val out = client.getOutputStream()
    out.write(head.toByteArray(Charsets.ISO_8859_1))
    out.write(body)
    out.flush()
  }
}
