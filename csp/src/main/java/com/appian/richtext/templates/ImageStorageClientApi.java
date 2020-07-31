package com.appian.richtext.templates;

import com.appian.connectedsystems.simplified.sdk.SimpleClientApi;
import com.appian.connectedsystems.simplified.sdk.SimpleClientApiRequest;
import com.appian.connectedsystems.templateframework.sdk.ClientApiResponse;
import com.appian.connectedsystems.templateframework.sdk.ExecutionContext;
import com.appian.connectedsystems.templateframework.sdk.TemplateId;
import com.appiancorp.services.ServiceContext;
import com.appiancorp.suiteapi.common.ServiceLocator;
import com.appiancorp.suiteapi.content.Content;
import com.appiancorp.suiteapi.content.ContentConstants;
import com.appiancorp.suiteapi.content.ContentOutputStream;
import com.appiancorp.suiteapi.content.ContentService;
import com.appiancorp.suiteapi.knowledge.Document;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;


import java.util.HashMap;
import java.util.Map;

@TemplateId(name = "ImageStorageClientApi")
public class ImageStorageClientApi extends SimpleClientApi {

    Logger logger = LoggerFactory.getLogger(ImageStorageClientApi.class);

    @Override
    protected ClientApiResponse execute(
            SimpleClientApiRequest simpleClientApiRequest, ExecutionContext executionContext) {

        Map<String,Object> resultMap = new HashMap<>();

        // Obtain the values from the request sent from the rich text editor.
        String imageData;
        long destinationFolder;

        try {
            imageData = (String) simpleClientApiRequest.getPayload().get("base64");
            destinationFolder = ((Integer) simpleClientApiRequest.getPayload().get("imageDestinationFolder")).longValue();
        } catch (Exception e) {
            logger.error("Unable to get data from client", e);
            resultMap.put("error", e.getLocalizedMessage());
            return new ClientApiResponse(resultMap);
        }

        // Convert base64 to a buffered image.
        String base64String = imageData.split(",")[1];
        String extension = imageData.substring("data:image/".length(), imageData.indexOf(";base64"));
        byte[] imageBytes = javax.xml.bind.DatatypeConverter.parseBase64Binary(base64String);

        // Create an Appian document.
        // I know this is deprecated, but the dependency injection strategy only works for
        // smart services and expression functions.
        // Reference:
        // https://community.appian.com/discussions/f/plug-ins/12745/contentservice-dependency-injection-not-working
        ServiceContext sc = ServiceLocator.getAdministratorServiceContext();
        ContentService cs = ServiceLocator.getContentService(sc);

        Document doc = new Document();
        doc.setName("Rich Text Editor Uploaded Image");
        doc.setExtension(extension);
        doc.setParent(destinationFolder);

        Long newImageId;
        try {
            ContentOutputStream cos;
            cos = cs.upload(doc, ContentConstants.UNIQUE_NONE);
            cos.write(imageBytes);
            cos.close();
            newImageId = cos.getContentId();
        } catch (Exception e) {
            logger.error("Error uploading doc", e);
            resultMap.put("error", e.getLocalizedMessage());
            return new ClientApiResponse(resultMap);
        }

        // Rename the file to include the docId.
        try {
            Content content;
            content = cs.getVersion(newImageId, ContentConstants.VERSION_CURRENT);
            content.setName(content.getName() + " " + newImageId);
            Integer[] columnsToUpdate = new Integer[]{ContentConstants.COLUMN_NAME};
            cs.updateFields(content, columnsToUpdate, ContentConstants.UNIQUE_NONE);
        } catch (Exception e) {
            logger.error("Error changing doc name", e);
            resultMap.put("error", e.getLocalizedMessage());
            return new ClientApiResponse(resultMap);
        }

        // Finalize the document.
        try {
            cs.setSizeOfDocumentVersion(newImageId);
        } catch (Exception e) {
            logger.error("Error setting size of document", e);
            resultMap.put("error", e.getLocalizedMessage());
            return new ClientApiResponse(resultMap);
        }

        // Return the document id back to the Rich Text Editor.
        logger.info("Returning new docId to client:" + newImageId);
        resultMap.put("docId", newImageId);

        return new ClientApiResponse(resultMap);
    }
}