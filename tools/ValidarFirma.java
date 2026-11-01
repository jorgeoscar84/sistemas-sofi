import javax.xml.crypto.AlgorithmMethod;
import javax.xml.crypto.Data;
import javax.xml.crypto.KeySelector;
import javax.xml.crypto.KeySelectorResult;
import javax.xml.crypto.NodeSetData;
import javax.xml.crypto.URIDereferencer;
import javax.xml.crypto.URIReference;
import javax.xml.crypto.URIReferenceException;
import javax.xml.crypto.XMLCryptoContext;
import javax.xml.crypto.dsig.Reference;
import javax.xml.crypto.dsig.XMLSignature;
import javax.xml.crypto.dsig.XMLSignatureFactory;
import javax.xml.crypto.dsig.dom.DOMValidateContext;
import javax.xml.crypto.dsig.keyinfo.KeyInfo;
import javax.xml.crypto.dsig.keyinfo.X509Data;
import javax.xml.parsers.DocumentBuilderFactory;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.cert.X509Certificate;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;

import org.w3c.dom.Attr;
import org.w3c.dom.Document;
import org.w3c.dom.Element;
import org.w3c.dom.Node;

/**
 * Validador XMLDSig/XAdES que usa únicamente el JDK (JSR 105).
 *
 * Uso:  java tools/ValidarFirma.java <archivo.xml>
 *
 * Comprueba SignatureValue sobre SignedInfo y todas las referencias internas
 * (digest del documento y de SignedProperties). Sale con código 0 si es válida.
 *
 * El XML del SRI referencia por atributo `id`/`Id` sin DTD, por lo que se registra
 * un URIDereferencer propio que resuelve `#id` recorriendo el DOM.
 */
public final class ValidarFirma {
    public static void main(String[] args) throws Exception {
        if (args.length < 1) {
            System.err.println("Uso: java ValidarFirma.java <archivo.xml>");
            System.exit(2);
        }
        Path path = Path.of(args[0]);
        try (InputStream input = Files.newInputStream(path)) {
            DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();
            factory.setNamespaceAware(true);
            Document document = factory.newDocumentBuilder().parse(input);
            var signatures = document.getElementsByTagNameNS(XMLSignature.XMLNS, "Signature");
            if (signatures.getLength() == 0) {
                System.err.println("NO_SIGNATURE");
                System.exit(1);
            }
            var signatureNode = signatures.item(0);
            DOMValidateContext context = new DOMValidateContext(new SimpleKeySelector(), signatureNode);
            context.setProperty("org.jcp.xml.dsig.secureValidation", Boolean.FALSE);
            context.setURIDereferencer(new IdDereferencer(document));
            XMLSignatureFactory xmlSignatureFactory = XMLSignatureFactory.getInstance("DOM");
            XMLSignature signature = xmlSignatureFactory.unmarshalXMLSignature(context);
            boolean coreValid = signature.validate(context);

            boolean debug = args.length > 1 && args[1].equals("--debug");
            List<String> references = new ArrayList<>();
            boolean referencesValid = true;
            for (Object item : signature.getSignedInfo().getReferences()) {
                Reference reference = (Reference) item;
                boolean valid = reference.validate(context);
                references.add((reference.getURI() == null ? "(documento)" : reference.getURI()) + "=" + valid);
                if (!valid) {
                    referencesValid = false;
                    if (debug) {
                        try {
                            Element element = findById(document.getDocumentElement(), reference.getURI().substring(1));
                            List<Node> nodes = new ArrayList<>();
                            collect(element, nodes);
                            javax.xml.crypto.Data data = new NodeSetDataImpl(nodes);
                            for (Object transformObject : reference.getTransforms()) {
                                javax.xml.crypto.dsig.Transform transform = (javax.xml.crypto.dsig.Transform) transformObject;
                                data = transform.transform(data, context);
                            }
                            byte[] canonical = ((javax.xml.crypto.OctetStreamData) data).getOctetStream().readAllBytes();
                            System.out.println("DEBUG_CANONICAL=" + new String(canonical, java.nio.charset.StandardCharsets.UTF_8));
                            System.out.println("DEBUG_DIGEST=" + java.util.Base64.getEncoder().encodeToString(
                                java.security.MessageDigest.getInstance("SHA-1").digest(canonical)));
                            System.out.println("DEBUG_EXPECTED_DIGEST=" + reference.getDigestValue().length);
                        } catch (Exception debugError) {
                            System.out.println("DEBUG_ERROR=" + debugError);
                        }
                    }
                }
            }

            String subject = "";
            KeyInfo keyInfo = signature.getKeyInfo();
            if (keyInfo != null) {
                for (Object content : keyInfo.getContent()) {
                    if (content instanceof X509Data data) {
                        for (Object certificateObject : data.getContent()) {
                            if (certificateObject instanceof X509Certificate certificate) {
                                subject = certificate.getSubjectX500Principal().getName();
                            }
                        }
                    }
                }
            }
            System.out.println("SIGNATURE_VALID=" + coreValid);
            System.out.println("REFERENCES=" + String.join(",", references));
            System.out.println("REFERENCES_VALID=" + referencesValid);
            System.out.println("SUBJECT=" + subject);
            boolean ok = coreValid && referencesValid;
            System.out.println(ok ? "RESULT=VALID" : "RESULT=INVALID");
            System.exit(ok ? 0 : 1);
        }
    }

    /** Selecciona el certificado incluido en ds:KeyInfo/ds:X509Data. */
    private static final class SimpleKeySelector extends KeySelector {
        @Override
        public KeySelectorResult select(KeyInfo keyInfo, KeySelector.Purpose purpose,
                                        AlgorithmMethod method, XMLCryptoContext context) {
            if (keyInfo == null) return null;
            for (Object content : keyInfo.getContent()) {
                if (content instanceof X509Data data) {
                    for (Object certificateObject : data.getContent()) {
                        if (certificateObject instanceof X509Certificate certificate) {
                            return () -> certificate.getPublicKey();
                        }
                    }
                }
            }
            return null;
        }
    }

    /** Resuelve referencias internas `#id` sin depender de DTD o xml:id. */
    private static final class IdDereferencer implements URIDereferencer {
        private final Document document;

        IdDereferencer(Document document) {
            this.document = document;
        }

        @Override
        public Data dereference(URIReference reference, XMLCryptoContext context) throws URIReferenceException {
            String uri = reference.getURI();
            if (uri == null || !uri.startsWith("#")) {
                throw new URIReferenceException("Sólo se soportan referencias internas (#id): " + uri);
            }
            String id = uri.substring(1);
            Element element = findById(document.getDocumentElement(), id);
            if (element == null) throw new URIReferenceException("No se encontró el elemento con id=" + id);
            List<Node> nodes = new ArrayList<>();
            collect(element, nodes);
            return new NodeSetDataImpl(nodes);
        }
    }

    private static final class NodeSetDataImpl implements NodeSetData {
        private final List<Node> nodes;

        NodeSetDataImpl(List<Node> nodes) {
            this.nodes = nodes;
        }

        @Override
        @SuppressWarnings("unchecked")
        public Iterator<Node> iterator() {
            return nodes.iterator();
        }
    }

    private static void collect(Element element, List<Node> nodes) {
        nodes.add(element);
        var attributes = element.getAttributes();
        for (int i = 0; i < attributes.getLength(); i++) {
            // Las declaraciones xmlns las resuelve el canonicalizador desde los elementos.
            if (!attributes.item(i).getNodeName().startsWith("xmlns")) {
                nodes.add(attributes.item(i));
            }
        }
        var children = element.getChildNodes();
        for (int i = 0; i < children.getLength(); i++) {
            Node child = children.item(i);
            nodes.add(child);
            if (child instanceof Element childElement) collect(childElement, nodes);
        }
    }

    private static Element findById(Element root, String id) {
        if (matches(root, id)) return root;
        var children = root.getChildNodes();
        for (int i = 0; i < children.getLength(); i++) {
            if (children.item(i) instanceof Element element) {
                Element found = findById(element, id);
                if (found != null) return found;
            }
        }
        return null;
    }

    private static boolean matches(Element element, String id) {
        for (String attribute : new String[] { "id", "Id", "ID" }) {
            String value = element.getAttribute(attribute);
            if (!value.isEmpty() && value.equals(id)) return true;
        }
        return false;
    }

    private ValidarFirma() {
    }
}



