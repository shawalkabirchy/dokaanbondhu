// DokaanBondhu AI's landing page (spec D249): the language switch, the email, the iPhone note and the QR code.
(function () {
  var root = document.documentElement;

  // Language: Bangla or English, remembered on this browser.
  function setLang(lang) {
    root.setAttribute("data-lang", lang);
    root.lang = lang;
    try {
      localStorage.setItem("db-lang", lang);
    } catch {
      /* private window: the choice lasts until the page closes */
    }
    document.querySelectorAll("[data-set-lang]").forEach(function (button) {
      button.setAttribute("aria-pressed", String(button.getAttribute("data-set-lang") === lang));
    });
  }
  document.querySelectorAll("[data-set-lang]").forEach(function (button) {
    button.addEventListener("click", function () {
      setLang(button.getAttribute("data-set-lang"));
    });
  });
  setLang(root.getAttribute("data-lang") === "bn" ? "bn" : "en");

  // The email is put together here, so the address is not sitting whole in the page for spam robots.
  var mail = document.getElementById("mail-link");
  var address = "";
  if (mail) {
    address = mail.getAttribute("data-u") + "@" + mail.getAttribute("data-d");
    mail.href = "mailto:" + address + "?subject=" + encodeURIComponent("DokaanBondhu AI demo login");
    mail.querySelector(".mail-text").textContent = address;
  }
  var copy = document.getElementById("mail-copy");
  var copied = document.getElementById("mail-copied");
  if (copy && address) {
    copy.addEventListener("click", function () {
      function done() {
        if (!copied) return;
        copied.hidden = false;
        setTimeout(function () {
          copied.hidden = true;
        }, 2500);
      }
      function selectIt() {
        var range = document.createRange();
        range.selectNodeContents(mail.querySelector(".mail-text"));
        var selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(address).then(done, selectIt);
      } else {
        selectIt();
      }
    });
  }

  // An iPhone or iPad gets a note: the app is for Android.
  var ua = navigator.userAgent || "";
  var apple = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  if (apple) {
    document.querySelectorAll(".ios-note").forEach(function (note) {
      note.hidden = false;
    });
  }

  // The QR code opens this page on a phone. Drawn by qrcode-generator (loaded from cdnjs); without it the address
  // below the box still shows.
  document.querySelectorAll("[data-qr]").forEach(function (box) {
    if (typeof window.qrcode !== "function") return;
    var code = window.qrcode(0, "M");
    code.addData(box.getAttribute("data-qr"));
    code.make();
    box.innerHTML = code.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
    var svg = box.querySelector("svg");
    if (svg) {
      svg.setAttribute("aria-hidden", "true");
      svg.querySelectorAll("path, rect").forEach(function (shape) {
        if (shape.getAttribute("fill") === "black" || shape.getAttribute("fill") === "#000000") {
          shape.setAttribute("fill", "#13241c");
        }
      });
    }
  });
})();
