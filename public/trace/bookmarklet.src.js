// Source of the Trace bookmarklet: the href of #bookmarkletBtn in public/trace/index.html.
//
// Build:  node scripts/build-bookmarklet.mjs          (rewrites that href)
// Check:  node scripts/build-bookmarklet.mjs --check  (fails if the href is out of date; run in CI)
//
// The build is deliberately simple so the output is predictable byte for byte:
//   1. lines whose first non-blank characters are "//" are dropped (so only full-line comments,
//      never trailing ones: "//" also appears inside strings and regexes below);
//   2. every other line has its leading and trailing whitespace removed;
//   3. the lines are joined with nothing in between;
//   4. the result is encodeURIComponent()-ed and prefixed with "javascript:".
// So each line break must sit where the joined code needs no space (never inside "else if",
// "var x", "return x", a string, etc.), and the code itself is written already minified, with
// the comments carrying the meaning. The file is also valid JS as it stands (node --check).
//
// public/trace/app.js retargetBookmarklet() swaps encodeURIComponent('"https://jinteki.win/trace/#log="')
// in the built href for the local origin on dev/preview hosts, so keep that exact string literal
// (double quotes included) in s() below.
//
// What it does, on a jinteki.net game page:
//   - finds the chat/game log, flattens it to the same plain text a manual copy-paste produces
//     (timestamps like [12:34:56] removed; a chat message becomes "user", "user", "text" lines,
//     matching how the log pastes);
//   - opens a new tab straight away (inside the click, so popup blockers allow it);
//   - gzips the text (CompressionStream) when available, base64url-encodes it and sends the tab
//     to https://jinteki.win/trace/#log=gz.<data> (or raw.<data> without CompressionStream).
//
// Variable key (single letters keep the URL short; they are hoisted function-scope vars):
//   e  the log's .messages element (inside the forEach: one child entry; in callbacks: the arg)
//   r  collected lines (later, in i(): the binary string; in s(): the final URL)
//   t  one system line, later the whole joined text
//   n  the .content element of a chat message, later the new tab (window) used by s()
//   a  username element, later the UTF-8 bytes of the text
//   o  username text, later the CompressionStream
//   l  the message's direct child divs, later the stream writer
//   i  message text; also the base64url helper function i()
//   s  navigates the new tab (or a fresh one) to the Trace URL
!function(){
  // Newer jinteki.net markup first, then the older one.
  var e=document.querySelector(".log .messages")||document.querySelector("div.messages");
  if(e){
    var r=[];
    Array.prototype.forEach.call(e.children,function(e){
      // System line ("X spends [click] to ..."): strip timestamps, collapse whitespace.
      if(e.classList.contains("system")){
        var t=e.textContent.replace(/\[\d{1,2}:\d{2}:\d{2}\]/g,"").replace(/\s+/g," ").trim();
        t&&r.push(t)
      }else if(e.classList.contains("message")){
        // Chat message: username (pushed twice, as a copy-paste of the log yields it) then the
        // text, which is the last direct child div of .content.
        var n=e.querySelector(".content");
        if(!n)return;
        var a=n.querySelector(".username"),
          o=a?a.textContent.replace(/\[\d{1,2}:\d{2}:\d{2}\]/g,"").trim():"",
          l=n.querySelectorAll(":scope > div"),
          i=l.length?l[l.length-1].textContent.replace(/\[\d{1,2}:\d{2}:\d{2}\]/g,"").trim():"";
        o&&(r.push(o),r.push(o)),
        i&&r.push(i)
      }
    });
    var t=r.join("\n");
    if(t){
      // Open the tab now, while still inside the user's click.
      var n=window.open("","_blank");
      n&&n.document.write("Preparing your Trace link...");
      var a=(new TextEncoder).encode(t);
      if(window.CompressionStream){
        var o=new CompressionStream("gzip"),
          l=o.writable.getWriter();
        l.write(a),
        l.close(),
        new Response(o.readable).arrayBuffer().then(function(e){
          s("gz."+i(new Uint8Array(e)))
        }).catch(function(e){
          n&&n.close(),
          alert("Trace: could not compress the log ("+e.message+").")
        })
      }else s("raw."+i(a))
    }else alert("Trace: the log panel is empty. Play or load a game first.")
  }else alert("Trace: could not find a game log on this page. Open a finished jinteki.net game first.");
  // Bytes -> base64url without padding. Chunked so String.fromCharCode.apply stays under
  // the engine's argument limit on long logs.
  function i(e){
    for(var r="",t=0;t<e.length;t+=32768)r+=String.fromCharCode.apply(null,e.subarray(t,t+32768));
    return btoa(r).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"")
  }
  // Send the pre-opened tab to Trace, or open one if the popup was blocked.
  function s(e){
    var r="https://jinteki.win/trace/#log="+e;
    n?n.location.href=r:window.open(r,"_blank")
  }
}();
