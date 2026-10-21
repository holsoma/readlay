import unittest

try:
    from . import import_pdf_book as pdf
except ImportError:
    import import_pdf_book as pdf


def char(text,x0,bottom,size=12,bold=False):
    return {"text":text,"x0":x0,"x1":x0+5,"top":bottom-size,"bottom":bottom,"size":size,"fontname":"Font-Bold" if bold else "Font"}


class PdfImportTests(unittest.TestCase):
    def test_small_capitals_share_baseline_without_reordering(self):
        chars = [char("Q",72,235,15.6,True),char("U",77,233.5,9,True),char("A",82,233.5,9,True),char("D",87,233.5,9,True)]
        lines = pdf.lines_from_chars(chars,1)
        self.assertEqual([line.text for line in lines],["QUAD"])
        self.assertEqual(lines[0].kind,"subheading")

    def test_real_compound_hyphen_is_preserved_without_inserted_space(self):
        self.assertEqual(pdf.join_lines("long-","term thinking"),"long-term thinking")
        self.assertEqual(pdf.join_lines("signifi\u00ad","cant change"),"significant change")
        self.assertEqual(pdf.join_lines("ordinary","prose"),"ordinary prose")

    def test_first_line_indent_starts_a_new_paragraph(self):
        previous = pdf.TextLine("A previous line",1,(72,72,539,84),12,0,0)
        current = pdf.TextLine("New paragraph",1,(86.4,86.4,539,98.4),12,0,0)
        self.assertTrue(pdf.is_new_paragraph(previous,current))

    def test_page_continuation_and_indented_page_start_are_distinct(self):
        previous = pdf.TextLine("A paragraph crosses",1,(72,700,539,712),12,0,0)
        continuation = pdf.TextLine("the page boundary.",2,(72,72,539,84),12,0,0)
        new = pdf.TextLine("Another paragraph.",2,(86.4,72,539,84),12,0,0)
        self.assertFalse(pdf.is_new_paragraph(previous,continuation))
        self.assertTrue(pdf.is_new_paragraph(previous,new))

    def test_transparent_diagrams_have_a_white_background(self):
        image = pdf.Image.new("RGBA",(20,20),(0,0,0,0))
        data,width,height = pdf.image_asset(image)
        self.assertEqual((width,height),(20,20))
        with pdf.Image.open(pdf.io.BytesIO(data)) as result:
            self.assertEqual(result.getpixel((0,0)),(255,255,255))

    def test_small_type_quote_continues_across_pages(self):
        previous = pdf.TextLine("unrelenting and",31,(85.8,702,498,711),9,0,0,"quote")
        continuation = pdf.TextLine("unforgiving.",32,(85.8,73,525,82),9,0,0,"quote")
        new_quote = pdf.TextLine("A fresh quote.",32,(92.55,84,525,93),9,0,0,"quote")
        self.assertFalse(pdf.is_new_paragraph(previous,continuation))
        self.assertTrue(pdf.is_new_paragraph(continuation,new_quote))

    def test_reviewed_footnote_reference_is_preserved_outside_prose(self):
        marker = char("1",426.4782,139.344,9)
        body = char("a",72,144.192,12)
        chars,references = pdf.separate_footnote_reference([body,marker],62)
        self.assertEqual(chars,[body])
        self.assertEqual(references[0]["value"],"1")
        self.assertEqual(references[0]["page"],62)

    def test_changed_reference_geometry_fails_instead_of_deleting_another_digit(self):
        with self.assertRaises(pdf.importer.ImportFailure):
            pdf.separate_footnote_reference([char("1",72,139.344,9)],62)

    def test_hanging_list_continuation_keeps_its_item(self):
        first = pdf.TextLine("2. A long list item",266,(74.4,100,539,112),12,0,0,"list-item")
        continuation = pdf.TextLine("or 3 days).",266,(96,114.4,160,126.4),12,0,0,"body")
        self.assertTrue(pdf.continues_hanging_list(pdf.Paragraph([first]),continuation))
        ordinary = pdf.TextLine("A fresh body paragraph.",266,(86.4,114.4,539,126.4),12,0,0,"body")
        self.assertFalse(pdf.continues_hanging_list(pdf.Paragraph([first]),ordinary))

    def test_nested_hanging_list_short_line_is_not_a_quote(self):
        first = pdf.TextLine("a. Organise your",127,(96,100,539,112),12,0,0,"list-item")
        continuation = pdf.TextLine("thoughts.",127,(108,114.4,150,126.4),12,0,0,"quote")
        self.assertTrue(pdf.continues_hanging_list(pdf.Paragraph([first]),continuation))

    def test_page_break_does_not_override_a_validated_list_continuation(self):
        previous = pdf.TextLine("3. Someone to delegate to or",155,(74.4,700,539,712),12,0,0,"list-item")
        continuation = pdf.TextLine("train to be responsible.",156,(96,72,539,84),12,0,0,"body")
        paragraph = pdf.Paragraph([previous])
        self.assertTrue(pdf.continues_hanging_list(paragraph,continuation))
        continuation.kind = "list-item"
        self.assertFalse(pdf.is_new_paragraph(previous,continuation))


if __name__ == "__main__":
    unittest.main()
