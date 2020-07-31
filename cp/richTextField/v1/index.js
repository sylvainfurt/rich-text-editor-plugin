const MAX_SIZE_DEFAULT = 10000;
const IS_MAC = navigator.platform.indexOf("Mac") > -1;
// Get parent window URL.
// Reference: https://stackoverflow.com/questions/3420004/access-parent-url-from-iframe
const PARENT_WINDOW_URL = (window.location != window.parent.location)
  ? document.referrer : document.location.href;
// The URL used in the source for the image tags.
const APPIAN_URL = new URL(PARENT_WINDOW_URL);
const CLIENT_API_FRIENDLY_NAME = "ImageStorageClientApi";
window.quillMaxSize = MAX_SIZE_DEFAULT;
window.isQuillActive = false;
window.currentValidations = [];
window.isReadOnly = false;
window.allowImages = false;
window.connectedSystem;
window.imageDestinationFolder;
// Exclude formats that don't match parity with Appian Rich Text Display Field
// Won't be able to paste unsupported formats
// Note this is separate from what toolbar allows
// https://quilljs.com/docs/formats/
// Also see getContentsFromHTML() where unsupported formats are removed
// from the incoming HTML value if present
const availableFormats = [
  ["header", "size"],
  ["bold", "italic", "underline", "strike", "color", "background"],
  ["link", "image"],
  ["align", "indent"],
  ["list"]
];
const availableFormatsFlattened = availableFormats.reduce(function (acc, val) {
  return acc.concat(val, []);
});
const defaultFormats = availableFormatsFlattened.filter(e => e !== 'image');
var allowedFormats = defaultFormats;

// This mimics the default Quill.js keyboard module with some slight modifications for 'Tab' handling
// https://github.com/quilljs/quill/blob/master/modules/keyboard.js
var bindings = {
  tab: {
    key: "Tab",
    handler: function(range, context) {
      if (context.collapsed && context.offset !== 0) {
        this.quill.insertText(range.index, "\t", Quill.sources.USER);
        this.quill.setSelection(range.index + 1, Quill.sources.USER);
        return false;
      } else {
        this.quill.format("indent", "+1", Quill.sources.USER);
        return false;
      }
    },
  },
  "custom-ol": {
    key: "7",
    shiftKey: true,
    shortKey: true,
    handler: function(range, context) {
      if (context.format.list !== "ordered") {
        this.quill.format("list", "ordered", true, Quill.sources.USER);
      } else {
        this.quill.format("list", false, Quill.sources.USER);
      }
    }
  },
  "custom-ul": {
    key: "8",
    shiftKey: true,
    shortKey: true,
    handler: function(range, context) {
      if (context.format.list !== "bullet") {
        this.quill.format("list", "bullet", true, Quill.sources.USER);
      } else {
        this.quill.format("list", false, Quill.sources.USER);
      }
    }
  }
};

var parentContainer = document.getElementById("parent-container");
var quillContainer = document.getElementById("quill-container");
var quill;

Appian.Component.onNewValue(function (allParameters) {
  const maxSize = allParameters.maxSize;
  const richText = allParameters.richText;
  const enableProgressBar = allParameters.enableProgressBar;
  const height = allParameters.height;
  const placeholder = allParameters.placeholder;
  window.imageDestinationFolder = allParameters.imageDestinationFolder;
  window.connectedSystem = allParameters.imageStorageConnectedSystem;
  window.allowImages = allParameters.allowImages;
  window.isReadOnly = allParameters.readOnly;

  /* Initialize Quill and set allowed formats and toolbar */
  if (!quill) {
    var Block = Quill.import('blots/block');
    Block.tagName = 'div';
    Quill.register(Block);
    Quill.register(Quill.import('attributors/style/background'), true);
    Quill.register(Quill.import('attributors/style/color'), true);
    Quill.register(Quill.import("attributors/style/size"), true);
    Quill.register(Quill.import("attributors/style/align"), true);
    allowedFormats =
      !allParameters.allowedFormats || !allParameters.allowedFormats.length
        ? defaultFormats
        : allParameters.allowedFormats;
    if (window.allowImages) {
      allowedFormats.push('image');
    }
    quill = new Quill(quillContainer, {
      formats: allowedFormats,
      modules: {
        toolbar: "#quill-toolbar",
        history: {
          delay: 500,
          maxStack: 500,
          userOnly: true
        },
        keyboard: {
          bindings: bindings
        }
      },
      placeholder: "",
      theme: "snow"
    });

    insertAccentColor(Appian.getAccentColor());

    /* Hide/show toolbar options based on if they are allowed formats */
    availableFormatsFlattened.forEach(function (format) {
      var nodeArray = Array.prototype.slice.call(document.querySelectorAll(buildCssSelector(format)));
      nodeArray.forEach(function (element) {
        element.style.display = allowedFormats.indexOf(format) >= 0 ? "block" : "none";
      });
    });

    /* Add spacing to the toolbar based on visibilities */
    availableFormats.forEach(function (formatList) {
      var cssSelectors = [];
      formatList.forEach(function (format) {
        if (allowedFormats.indexOf(format) >= 0) {
          cssSelectors.push(buildCssSelector(format));
        }
      });
      if (cssSelectors.length > 0) {
        var elementsOfFormatList = document.querySelectorAll(cssSelectors.join(","));
        var lastElementOfFormatList = elementsOfFormatList[elementsOfFormatList.length - 1];
        lastElementOfFormatList.classList.add("ql-spacer");
      }
    });

    /* Update tooltips for Mac vs. PC */
    var tooltipArray = Array.prototype.slice.call(document.querySelectorAll("[tooltip]"));
    tooltipArray.forEach(function (element) {
      element.setAttribute("tooltip", element.getAttribute("tooltip").replace("%", IS_MAC ? "Cmd" : "Ctrl"));
    });

    quill.on("text-change", debounce(function (delta, oldDelta, source) {
      /* Skip if an image is present that has not been converted to a file yet */
      let images = [];
      if (window.allowImages) {
        images = Array.from(
          /* Looks for base64 strings */
          quill.container.querySelectorAll('img[src^="data:"]')
        );
      }

      if (source == "user" && images.length == 0) {
        window.isQuillActive = true;
        validate(false);
        updateValue();
      }
    }, 500)
    );

    /**
     * Additional event handler for inserted images (with no debounce).
     * Uploads the base64 string to Appian, stores the image as a file,
     * and replaces the base64 string in the Quill editor with the document
     * URL from Appian.
     *
     * Reference:
     * https://github.com/quilljs/quill/issues/1089#issuecomment-613640103
     */
    if (window.allowImages) {
      quill.on("text-change", async function(delta, oldDelta, source) {
        const images = Array.from(
          quill.container.querySelectorAll('img[src^="data:"]:not(.loading)')
        );
        for (const image of images) {
          image.classList.add("loading");
          image.setAttribute("src", await uploadBase64Img(
            image)
          );
          image.classList.remove("loading");
        }
      });
    }

    /* only update when focus is lost (when relatedTarget == null) */
    quill.root.addEventListener("blur", function (focusEvent) {
      // See https://github.com/quilljs/quill/issues/1951#issuecomment-408990849
      if (focusEvent && !focusEvent.relatedTarget) {
        window.isQuillActive = false;
        updateValue();
      }
    });
  }

  /* Update maxSize if specified */
  window.quillMaxSize = maxSize || MAX_SIZE_DEFAULT;

  /* Apply display settings */
  handleDisplay(enableProgressBar, height, placeholder);

  /* update value if user isn't currently editing */
  if (window.isQuillActive) {
    console.warn("Not updating contents because quill is active");
  } else {
    const contents = getContentsFromHTML(richText);
    quill.setContents(contents);
  }

  /* Check max size */
  validate(true);
});

initializeCopyPaste();

function updateValue() {
  if (validate(false)) {
    const contents = quill.getContents();
    /* Save value (Quill always adds single newline at end, so treat that as null) */
    /* Check getLength() in case an image is added without any text */
    if (quill.getText() === "\n" && quill.getLength() == 1) {
      Appian.Component.saveValue("richText", null);
    } else {
      const html = getHTMLFromContents(contents);
      Appian.Component.saveValue("richText", html);
    }
  }
}

/************ Utility Methods *************/
function insertAccentColor(color) {
  var styleEl = document.createElement("style");
  document.head.appendChild(styleEl);
  var styleSheet = styleEl.sheet;
  styleSheet.insertRule("h3" + "{" + "color: " + color + "}", styleSheet.cssRules.length);
}

function handleDisplay(enableProgressBar, height, placeholder) {
  quill.enable(!window.isReadOnly);
  /* Toolbar */
  var toolbar = document.querySelector(".ql-toolbar");
  toolbar.style.display = window.isReadOnly ? "none" : "block";
  /* Progress Bar */
  var progressBar = document.getElementById("sizeBar");
  var showProgressBar = enableProgressBar !== false && !window.isReadOnly;
  progressBar.style.display = showProgressBar ? "block" : "none";
  /* Height
     IE11 doesn't support flexbox so instead manually set heights and minHeights
     https://caniuse.com/#feat=flexbox
  */
  if (window.isReadOnly) {
    /* When readonly, don't specify any minHeight or height to limit height to match the content */
    quillContainer.style.height = "auto";
    parentContainer.style.height = "auto";
    quillContainer.style.minHeight = "";
    parentContainer.style.minHeight = "";
  } else if (height == "auto") {
    /* For "auto" height, start with a min height but allow to grow taller as content increases */
    quillContainer.style.height = "auto";
    parentContainer.style.height = "auto";
    /* Reserve ~60px for toolbar and progressBar. Reserve 45px for toolbar without progressBar */
    quillContainer.style.minHeight = showProgressBar ? "100px" : "115px";
    parentContainer.style.minHeight = "160px"; /* This is a randomly-selected, good looking default */
  } else {
    /* For designer-specified heights, force height to match exactly and not grow */
    quillContainer.style.minHeight = "";
    parentContainer.style.minHeight = "";
    var heightInt = parseInt(height);
    /* Reserve ~60px for toolbar and progressBar. Reserve 45px for toolbar without progressBar */
    quillContainer.style.height = heightInt - (showProgressBar ? 60 : 45) + "px";
    parentContainer.style.height = heightInt + "px";
  }
  /* Placeholder */
  quill.root.dataset.placeholder = placeholder && !window.isReadOnly ? placeholder : "";
}

function getContentsFromHTML(html) {
  /* Use a new, temporary Quill because update doesn't work if the current Quill is readonly */
  var tempQuill = new Quill(document.createElement("div"), { formats: allowedFormats });
  html = revertIndentInlineToClass(html);
  tempQuill.root.innerHTML = html;
  tempQuill.update();
  var richTextContents = tempQuill.getContents();
  return richTextContents;
}

// This function provides backwards compatibility from the inline indentation to the class indentation
// Previously, a single indentation was <p style="margin-left: 1em;">
// Now, a single indentation is <p class="ql-indent-1">
function revertIndentInlineToClass(html) {
  var indentRegex = /style="margin-left: ([0-9]+)em;"/gi;
  return html.replace(indentRegex, replaceIndentRegex);
  function replaceIndentRegex(match) {
    return match.replace('style="margin-left: ', 'class="ql-indent-').replace('em;"', '"');
  }
}

function getHTMLFromContents(contents) {
  var tempQuill = new Quill(document.createElement("div"));
  tempQuill.setContents(contents);
  return tempQuill.root.innerHTML;
}

/**
 * Enforce validations (currently just size validation)
 * @param {boolean} forceUpdate - If true, will execute setValidations() regardless of validation change (because of Appian caching of validations)
 * @return {boolean} Whether the component is valid
 */
function validate(forceUpdate) {
  const size = getSize();
  updateUsageBar(size);
  var newValidations = [];
  if (window.allowImages) {
    if (!window.imageDestinationFolder) {
      newValidations.push('The image destination folder parameter is empty. Please update the parameter "imageDestinationFolder" with a valid folder or set "allowImages" to false.');
    }
    if (!window.connectedSystem) {
      newValidations.push('The image storage connected system parameter is empty. Please update the parameter "imageStorageConnectedSystem" with a valid connected system or set "allowImages" to false.');
    }
  }
  if (size > window.quillMaxSize && !window.isReadOnly) {
    newValidations.push("Content exceeds maximum allowed size");
  }
  if (forceUpdate || !(newValidations.toString() === window.currentValidations.toString())) {
    Appian.Component.setValidations(newValidations);
  }
  window.currentValidations = newValidations;
  return window.currentValidations.length === 0;
}

function getSize() {
  if (quill.getText() === "\n") {
    return 0;
  }
  const contents = quill.getContents();
  const html = getHTMLFromContents(contents);
  return html.length;
}

function updateUsageBar(size) {
  var usageBar = document.getElementById("usageBar");
  var usageMessage = document.getElementById("usageMessage");
  const usage = Math.round((100 * size) / window.quillMaxSize);
  const usagePercent = usage <= 100 ? usage + "%" : "100%";
  /* update usage message */
  const message = " " + usagePercent + " used";
  usageMessage.innerHTML = message;
  /* update usage bar width and color */
  usageBar.style.width = usagePercent;
  if (usage <= 75) {
    usageBar.style.backgroundColor = Appian.getAccentColor();
  } else if (usage <= 90) {
    usageBar.style.backgroundColor = "orange";
  } else {
    usageBar.style.backgroundColor = "red";
  }
}

function buildCssSelector(format) {
  return "button.ql-" + format + ",span.ql-" + format;
}

function debounce(func, delay) {
  var inDebounce;
  return function() {
    const context = this;
    const args = arguments;
    clearTimeout(inDebounce);
    inDebounce = setTimeout(function() {
      func.apply(context, args);
    }, delay);
  };
}

async function uploadBase64Img(imageSelector) {
  if (!window.connectedSystem || !window.imageDestinationFolder) {
    return;
  }
  let docId;
  let message;

  function handleClientApiResponseForBase64(response) {
    if (response.payload.error) {
      console.error('Connected system response: ' + response.payload.error);
      Appian.Component.setValidations('Connected system response: ' + response.payload.error);
      return;
    }

    docId = response.payload.docId;

    if (docId == null) {
      message = 'Unable to obtain the doc id from the connected system';
      console.error(message);
      Appian.Component.setValidations(message);
      return;
    }
    else {
      // Clear any error messages
      Appian.Component.setValidations([]);
      return docId;
    }
  }

  function handleError(response) {
    if (response.error && response.error[0]) {
      console.error(response.error);
      Appian.Component.setValidations([response.error]);
    } else {
      message = 'An unspecified error occurred';
      console.error(message);
      Appian.Component.setValidations([message]);
    }
  }

  base64Str = imageSelector.getAttribute("src");
  if (typeof base64Str !== 'string' || base64Str.length < 100) {
    return base64Str;
  }
  const payload = {
    base64: base64Str,
    imageDestinationFolder: window.imageDestinationFolder
  };

  await Appian.Component.invokeClientApi(window.connectedSystem, CLIENT_API_FRIENDLY_NAME, payload)
    .then(handleClientApiResponseForBase64)
    .catch(handleError);

  return APPIAN_URL.protocol + '//' + APPIAN_URL.host + '/suite/doc/' + docId;
}

/**
 * Gets the user's browser and version.
 *
 * Reference:
 * https://stackoverflow.com/questions/5916900/how-can-you-detect-the-version-of-a-browser
 *
 * @return {String} The browser and version, i.e. Chrome 62
 */
function getBrowserAndVersion() {
  var ua= navigator.userAgent, tem,
  M= ua.match(/(opera|chrome|safari|firefox|msie|trident(?=\/))\/?\s*(\d+)/i) || [];
  if(/trident/i.test(M[1])){
    tem=  /\brv[ :]+(\d+)/g.exec(ua) || [];
    return 'IE '+(tem[1] || '');
  }
  if(M[1]=== 'Chrome'){
    tem= ua.match(/\b(OPR|Edge)\/(\d+)/);
    if(tem!= null) return tem.slice(1).join(' ').replace('OPR', 'Opera');
  }
  M= M[2]? [M[1], M[2]]: [navigator.appName, navigator.appVersion, '-?'];
  if((tem= ua.match(/version\/(\d+)/i))!= null) M.splice(1, 1, tem[1]);
  return M.join(' ');
}

/**
 * Enable copy/paste from clipboard for non-html images.
 * Reference: https://github.com/quilljs/quill/issues/137
 */
function initializeCopyPaste() {
  var browserArray = getBrowserAndVersion().split(" ");
  var browser = browserArray[0];
  var browserVersion = browserArray[1];
  if (browser != "Firefox" && browser != 'Chrome') {
    var IMAGE_MIME_REGEX = /^image\/(p?jpeg|gif|png)$/i;
    var loadImage = function (file) {
      var reader = new FileReader();
      reader.onload = function(e){
        var img = document.createElement('img');
        img.src = e.target.result;
        var range = window.getSelection().getRangeAt(0);
        range.deleteContents();
        range.insertNode(img);
      };
      reader.readAsDataURL(file);
    };

    document.onpaste = function(e){
      var items = e.clipboardData.items;

      for (var i = 0; i < items.length; i++) {
        if (IMAGE_MIME_REGEX.test(items[i].type)) {
            loadImage(items[i].getAsFile());
            return;
        }
      }
    }
  }
}