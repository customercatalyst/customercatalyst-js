// Forwards every request, unchanged, to the Messenger/form Worker through the WIDGET service binding.
//
// Unchanged matters: the Worker reads the URL host (hosted /f/<slug>, Turnstile hostname, cache
// keys), Origin, and CF-Connecting-IP (per-IP rate limits). A service binding is not an internet
// subrequest, so the Request object — URL and headers — arrives as is. CF-Connecting-IP stays the one
// Cloudflare set when the visitor reached this host; a client cannot forge it here or on the Worker's
// own workers.dev URL, because Cloudflare overwrites it at the edge. No extra header, nothing to trust.
export default {
  fetch(request, env) {
    return env.WIDGET.fetch(request);
  },
};
