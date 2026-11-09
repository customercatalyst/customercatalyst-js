// Forwards survey requests, unchanged, to the Messenger/form Worker (see pages-proxy/public/_worker.js
// for why unchanged matters). Only the survey routes pass; everything else on this host is a 404.
const SURVEY = /^\/(s\/[^/]+(\/unsubscribe|\/logo)?|v1\/survey\.js|v1\/survey\/(answer|unsubscribe))$/;

export default {
  fetch(request, env) {
    if (!SURVEY.test(new URL(request.url).pathname)) return new Response('Not found', { status: 404 });
    return env.WIDGET.fetch(request);
  },
};
