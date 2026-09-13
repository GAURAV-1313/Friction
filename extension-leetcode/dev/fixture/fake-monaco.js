// fake-monaco.js: the smallest editor surface the extension reads on leetcode.com (classic script, no modules).
//
// window.monaco.editor.getEditors() -> editors whose getDomNode() lives inside #editor and whose
// getModel().getValue() returns the code (backed by a <textarea>). Focus mode swaps the Monaco editor
// for a CodeMirror 6 look-alike: an element with class "cm-content" carrying
// element.cmView.view.state.doc.toString(). Both are re-created on every "navigation" so an extension
// that caches a model across pushState reads stale code (verification #11 in the plan).
(function () {
  'use strict';

  var registry = [];

  function createEditor(host, value, languageId) {
    var textarea = document.createElement('textarea');
    textarea.className = 'fake-monaco';
    textarea.spellcheck = false;
    textarea.value = value || '';
    host.appendChild(textarea);
    var model = {
      _languageId: languageId || 'cpp',
      getValue: function () { return textarea.value; },
      setValue: function (v) { textarea.value = v == null ? '' : String(v); },
      getLanguageId: function () { return model._languageId; },
      setLanguageId: function (id) { model._languageId = id; }
    };
    var editor = {
      getDomNode: function () { return textarea; },
      getModel: function () { return model; },
      getValue: function () { return model.getValue(); },
      setValue: function (v) { model.setValue(v); },
      focus: function () { textarea.focus(); },
      dispose: function () {
        if (textarea.parentNode) textarea.parentNode.removeChild(textarea);
        var i = registry.indexOf(editor);
        if (i >= 0) registry.splice(i, 1);
      }
    };
    registry.push(editor);
    return editor;
  }

  // CodeMirror 6 stand-in for Focus mode. A textarea keeps it editable; the class and cmView are what matter.
  function createCm(host, value) {
    var el = document.createElement('textarea');
    el.className = 'cm-content';
    el.spellcheck = false;
    el.value = value || '';
    host.appendChild(el);
    var view = { state: { doc: { toString: function () { return el.value; }, get length() { return el.value.length; } } } };
    el.cmView = { view: view };
    return {
      dom: el,
      view: view,
      getValue: function () { return el.value; },
      setValue: function (v) { el.value = v == null ? '' : String(v); },
      dispose: function () { if (el.parentNode) el.parentNode.removeChild(el); }
    };
  }

  window.monaco = {
    editor: {
      getEditors: function () { return registry.slice(); },
      create: createEditor,
      getModels: function () { return registry.map(function (e) { return e.getModel(); }); }
    }
  };

  window.__fixtureEditors = { createEditor: createEditor, createCm: createCm, registry: registry };
})();
