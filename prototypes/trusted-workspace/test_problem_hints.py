"""Optional problem hints must not alter draft, evidence or judging."""
import unittest

import chrome_pipe
from runtime import STATE


class ProblemHints(unittest.TestCase):
    def setUp(self):
        base = STATE / 'h'
        base.mkdir(exist_ok=False)
        chrome_pipe.BASE = base
        chrome_pipe.OUT = STATE / 'evidence'
        self.browser = chrome_pipe.ChromePipe('hints')
        self.addCleanup(self.close)
        self.browser.wait("!document.getElementById('draft').disabled")

    def close(self):
        self.assertTrue(self.browser.close()['clean_browser_close'])

    def test_three_optional_hints_are_collapsed_and_do_not_touch_draft(self):
        before = self.browser.js("(() => ({draft:document.getElementById('draft').value,evidence:document.getElementById('fixture-evidence').textContent}))()")
        self.assertEqual(self.browser.js("document.querySelectorAll('#hints details.hint').length"), 3)
        self.assertTrue(self.browser.js("Array.from(document.querySelectorAll('#hints details.hint')).every(h=>!h.open)"))
        self.browser.js("document.querySelector('#hints details.hint summary').focus()")
        self.browser.cdp('Input.dispatchKeyEvent', type='keyDown', key='Enter', code='Enter', windowsVirtualKeyCode=13, text='\r')
        self.browser.cdp('Input.dispatchKeyEvent', type='keyUp', key='Enter', code='Enter', windowsVirtualKeyCode=13)
        self.assertTrue(self.browser.js("document.querySelector('#hints details.hint').open"))
        self.assertTrue(self.browser.js("Array.from(document.querySelectorAll('#hints details.hint')).slice(1).every(h=>!h.open)"))
        self.assertEqual(self.browser.js("(() => ({draft:document.getElementById('draft').value,evidence:document.getElementById('fixture-evidence').textContent}))()"), before)
        self.assertEqual(self.browser.js("document.getElementById('run-result').textContent"), '')


if __name__ == '__main__':
    unittest.main()
