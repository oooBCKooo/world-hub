import unittest
from logic import statistics
class StatisticsTest(unittest.TestCase):
    def test_exact_unicode(self):
        self.assertEqual(statistics('')['sha256'], 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
        value = statistics('中🌍\r\n')
        self.assertEqual((value['codePoints'], value['lines'], value['utf8Bytes']), (4, 2, 9))
        with self.assertRaises(UnicodeEncodeError): statistics('\ud800')
        with self.assertRaises(ValueError): statistics('a' * 16385)
if __name__ == '__main__': unittest.main()
