"""Real-browser editor indent regression; no native app or learner execution."""
import json
import unittest

import chrome_pipe
from runtime import STATE


class EditorIndent(unittest.TestCase):
    def setUp(self):
        labels = {'test_tab_inserts_four_spaces_and_persists': 'e1',
                  'test_multiline_indent_and_outdent_selection': 'e2',
                  'test_unselected_shift_tab_leaves_editor': 'e3',
                  'test_indent_is_undoable_without_losing_typed_text': 'e4',
                  'test_selection_ending_at_line_boundary_excludes_next_line': 'e6',
                  'test_newline_only_and_empty_line_selection': 'e7',
                  'test_partial_prefix_outdent_keeps_selection_safe': 'e8',
                  'test_unsupported_or_throwing_insert_restores_selection': 'e11',
                  'test_outdent_mixed_indent_backward_and_repeated': 'e9',
                  'test_unicode_selection_uses_utf16_offsets': 'e10',
                  'test_outdent_undo_redo_preserves_typed_text': 'e12',
                  'test_readonly_draft_keeps_normal_tab_focus': 'e13'}
        base = STATE / labels[self._testMethodName]
        base.mkdir(exist_ok=False)
        chrome_pipe.BASE = base
        chrome_pipe.OUT = STATE / 'editor-indent-evidence'
        self.browser = chrome_pipe.ChromePipe(self._testMethodName)
        self.addCleanup(self.close)
        self.browser.wait("!document.getElementById('draft').disabled")

    def close(self):
        self.assertTrue(self.browser.close()['clean_browser_close'])

    def key(self, shift=False):
        params = dict(key='Tab', code='Tab', windowsVirtualKeyCode=9)
        if shift:
            params['modifiers'] = 8
        self.browser.cdp('Input.dispatchKeyEvent', type='keyDown', **params)
        self.browser.cdp('Input.dispatchKeyEvent', type='keyUp', **params)

    def test_tab_inserts_four_spaces_and_persists(self):
        self.browser.js("(() => {const d=document.getElementById('draft');d.value='def solve(nums):\\n    return 0';d.focus();d.setSelectionRange(0,0)})()")
        self.key()
        state = self.browser.js("(() => {const d=document.getElementById('draft');return {value:d.value,start:d.selectionStart,end:d.selectionEnd,focus:document.activeElement.id,position:document.getElementById('position').textContent}})()")
        self.assertEqual(state, {'value': '    def solve(nums):\n    return 0', 'start': 4, 'end': 4, 'focus': 'draft', 'position': 'Ln 1, Col 5'})
        self.browser.wait("document.getElementById('save-status').dataset.state==='saved'")
        self.assertEqual(self.browser.js("document.getElementById('line-numbers').textContent"), '1\n2')

    def test_multiline_indent_and_outdent_selection(self):
        self.browser.js("(() => {const d=document.getElementById('draft');d.value='a\\nb\\n';d.focus();d.setSelectionRange(0,3)})()")
        self.key()
        self.assertEqual(self.browser.js("document.getElementById('draft').value"), '    a\n    b\n')
        self.assertEqual(self.browser.js("[document.getElementById('draft').selectionStart,document.getElementById('draft').selectionEnd]"), [0,11])
        self.key(shift=True)
        self.assertEqual(self.browser.js("document.getElementById('draft').value"), 'a\nb\n')
        self.assertEqual(self.browser.js("[document.getElementById('draft').selectionStart,document.getElementById('draft').selectionEnd]"), [0,3])
        self.browser.wait("document.getElementById('save-status').dataset.state==='saved'")

    def test_selection_ending_at_line_boundary_excludes_next_line(self):
        self.browser.js("(() => {const d=document.getElementById('draft');d.value='a\\nb\\nc';d.focus();d.setSelectionRange(0,2)})()")
        self.key()
        self.assertEqual(self.browser.js("document.getElementById('draft').value"), '    a\nb\nc')
        self.key(shift=True)
        self.assertEqual(self.browser.js("document.getElementById('draft').value"), 'a\nb\nc')

    def test_newline_only_and_empty_line_selection(self):
        cases = [('a\nb', 1, 2, '    a\nb'), ('\na', 0, 1, '    \na'),
                 ('a\n\nb', 2, 3, 'a\n    \nb'), ('a\n', 1, 2, '    a\n')]
        for before, start, end, indented in cases:
            with self.subTest(before=repr(before), selection=(start, end)):
                self.browser.js("(() => {const d=document.getElementById('draft');d.value=" +
                                json.dumps(before) + f";d.focus();d.setSelectionRange({start},{end})" + "})()")
                self.key()
                self.assertEqual(self.browser.js("document.getElementById('draft').value"), indented)
                self.key(shift=True)
                self.assertEqual(self.browser.js("document.getElementById('draft').value"), before)

    def test_partial_prefix_outdent_keeps_selection_safe(self):
        self.browser.js("(() => {const d=document.getElementById('draft');d.value='    abc\\n    def';d.focus();d.setSelectionRange(1,2)})()")
        self.key(shift=True)
        self.assertEqual(self.browser.js("document.getElementById('draft').value"), 'abc\n    def')
        self.assertEqual(self.browser.js("[document.getElementById('draft').selectionStart,document.getElementById('draft').selectionEnd]"), [0,0])
        self.browser.cdp('Input.insertText', text='Z')
        self.assertEqual(self.browser.js("document.getElementById('draft').value"), 'Zabc\n    def')

    def test_unsupported_or_throwing_insert_restores_selection(self):
        self.browser.wait("!document.getElementById('save-status').textContent.startsWith('Opening')")
        for mode, replacement in [('false', '()=>false'), ('missing', 'undefined'),
                                  ('throws', '()=>{throw new Error("unsupported")}')]:
            with self.subTest(mode=mode):
                self.browser.js("(() => {const d=document.getElementById('draft');d.value='x\\n    y';d.focus();d.setSelectionRange(1,5,'backward');window.__inputs=0;d.addEventListener('input',()=>window.__inputs++,{once:true});document.execCommand=" + replacement + "})()")
                status = self.browser.js("document.getElementById('save-status').textContent")
                self.key()
                self.assertEqual(self.browser.js("(() => {const d=document.getElementById('draft');return [d.value,d.selectionStart,d.selectionEnd,d.selectionDirection,window.__inputs]})()"),
                                 ['x\n    y', 1, 5, 'backward', 0])
                self.assertEqual(self.browser.js("document.getElementById('save-status').textContent"), status)
                self.browser.js("document.getElementById('draft').setSelectionRange(0,0)")
                self.key(shift=True)
                self.assertNotEqual(self.browser.js('document.activeElement.id'), 'draft')

    def test_outdent_mixed_indent_backward_and_repeated(self):
        d = "document.getElementById('draft')"
        self.browser.js("(() => {const d=" + d + ";d.value='a\\n    b';d.focus();d.setSelectionRange(0,4,'backward')})()")
        self.key(shift=True)
        self.assertEqual(self.browser.js(f"[{d}.value,{d}.selectionStart,{d}.selectionEnd,{d}.selectionDirection]"),
                         ['a\nb', 0, 2, 'backward'])
        self.browser.js("(() => {const d=" + d + ";d.value='        a\\n    b';d.focus();d.setSelectionRange(0,d.value.length,'backward')})()")
        self.key(shift=True)
        self.assertEqual(self.browser.js(f"[{d}.value,{d}.selectionStart,{d}.selectionEnd,{d}.selectionDirection]"),
                         ['    a\nb', 0, len('    a\nb'), 'backward'])
        self.key(shift=True)
        self.assertEqual(self.browser.js(f"[{d}.value,{d}.selectionStart,{d}.selectionEnd,{d}.selectionDirection]"),
                         ['a\nb', 0, len('a\nb'), 'backward'])

    def test_unicode_selection_uses_utf16_offsets(self):
        d = "document.getElementById('draft')"
        for original in ['🦊a\n    b', 'e\u0301a\n    b']:
            with self.subTest(original=original):
                self.browser.js("(() => {const d=" + d + ";d.value=" + json.dumps(original) + ";d.focus();d.setSelectionRange(d.value.indexOf('a'),d.value.length,'backward')})()")
                self.key()
                self.assertEqual(self.browser.js(f'{d}.value'), '    ' + original.replace('\n    b', '\n        b'))
                self.key(shift=True)
                self.assertEqual(self.browser.js(f'{d}.value'), original)

    def test_indent_is_undoable_without_losing_typed_text(self):
        self.browser.js("(() => {const d=document.getElementById('draft');d.value='';d.focus()})()")
        self.browser.cdp('Input.insertText', text='a\nb')
        self.browser.js("document.getElementById('draft').setSelectionRange(0,3)")
        self.key()
        self.assertEqual(self.browser.js("document.getElementById('draft').value"), '    a\n    b')
        self.browser.cdp('Input.dispatchKeyEvent', type='keyDown', key='z', code='KeyZ', windowsVirtualKeyCode=90, modifiers=2)
        self.browser.cdp('Input.dispatchKeyEvent', type='keyUp', key='z', code='KeyZ', windowsVirtualKeyCode=90, modifiers=2)
        self.assertEqual(self.browser.js("document.getElementById('draft').value"), 'a\nb')

    def test_outdent_undo_redo_preserves_typed_text(self):
        d = "document.getElementById('draft')"
        self.browser.js(f"{d}.value='';{d}.focus()")
        self.browser.cdp('Input.insertText', text='    a\n    b')
        self.browser.js(f'{d}.setSelectionRange(0,{d}.value.length)')
        self.key(shift=True)
        self.assertEqual(self.browser.js(f'{d}.value'), 'a\nb')
        self.browser.cdp('Input.dispatchKeyEvent', type='keyDown', key='z', code='KeyZ', windowsVirtualKeyCode=90, modifiers=2)
        self.browser.cdp('Input.dispatchKeyEvent', type='keyUp', key='z', code='KeyZ', windowsVirtualKeyCode=90, modifiers=2)
        self.assertEqual(self.browser.js(f'{d}.value'), '    a\n    b')
        self.browser.cdp('Input.dispatchKeyEvent', type='keyDown', key='Z', code='KeyZ', windowsVirtualKeyCode=90, modifiers=10)
        self.browser.cdp('Input.dispatchKeyEvent', type='keyUp', key='Z', code='KeyZ', windowsVirtualKeyCode=90, modifiers=10)
        self.assertEqual(self.browser.js(f'{d}.value'), 'a\nb')

    def test_readonly_draft_keeps_normal_tab_focus(self):
        self.browser.js("(() => {const d=document.getElementById('draft');d.readOnly=true;d.focus();d.setSelectionRange(0,0)})()")
        before = self.browser.js("document.getElementById('draft').value")
        self.key()
        self.assertNotEqual(self.browser.js('document.activeElement.id'), 'draft')
        self.assertEqual(self.browser.js("document.getElementById('draft').value"), before)

    def test_unselected_shift_tab_leaves_editor(self):
        self.browser.js("(() => {const d=document.getElementById('draft');d.focus();d.setSelectionRange(0,0)})()")
        self.key(shift=True)
        self.assertNotEqual(self.browser.js('document.activeElement.id'), 'draft')


if __name__ == '__main__':
    unittest.main()
