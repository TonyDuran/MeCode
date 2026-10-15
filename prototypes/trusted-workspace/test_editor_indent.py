"""Real-browser editor indent regression; no native app or learner execution."""
import unittest

import chrome_pipe
from runtime import STATE


class EditorIndent(unittest.TestCase):
    def setUp(self):
        labels = {'test_tab_inserts_four_spaces_and_persists': 'e1',
                  'test_multiline_indent_and_outdent_selection': 'e2',
                  'test_unselected_shift_tab_leaves_editor': 'e3',
                  'test_indent_is_undoable_without_losing_typed_text': 'e4',
                  'test_selection_ending_at_line_boundary_excludes_next_line': 'e6'}
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

    def test_indent_is_undoable_without_losing_typed_text(self):
        self.browser.js("(() => {const d=document.getElementById('draft');d.value='';d.focus()})()")
        self.browser.cdp('Input.insertText', text='a\nb')
        self.browser.js("document.getElementById('draft').setSelectionRange(0,3)")
        self.key()
        self.assertEqual(self.browser.js("document.getElementById('draft').value"), '    a\n    b')
        self.browser.cdp('Input.dispatchKeyEvent', type='keyDown', key='z', code='KeyZ', windowsVirtualKeyCode=90, modifiers=2)
        self.browser.cdp('Input.dispatchKeyEvent', type='keyUp', key='z', code='KeyZ', windowsVirtualKeyCode=90, modifiers=2)
        self.assertEqual(self.browser.js("document.getElementById('draft').value"), 'a\nb')

    def test_unselected_shift_tab_leaves_editor(self):
        self.browser.js("(() => {const d=document.getElementById('draft');d.focus();d.setSelectionRange(0,0)})()")
        self.key(shift=True)
        self.assertNotEqual(self.browser.js('document.activeElement.id'), 'draft')


if __name__ == '__main__':
    unittest.main()
