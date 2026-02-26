const fs = require('fs');
const archiver = require('archiver');
const path = require('path');

// Remonter au répertoire racine du projet
const projectRoot = path.resolve(__dirname, '..');

// Lisez les métadonnées de votre package.json
const packageJson = require(path.join(projectRoot, 'package.json'));
const vsixFilename = path.join(projectRoot, `${packageJson.name}-${packageJson.version}.vsix`);

// Définir le contenu du fichier [Content_Types].xml
const contentTypesXml = `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="json" ContentType="application/json"/>
  <Default Extension="vsixmanifest" ContentType="text/xml"/>
  <Default Extension="md" ContentType="text/markdown"/>
  <Default Extension="js" ContentType="application/javascript"/>
  <Default Extension="png" ContentType="image/png"/>
  <Default Extension="svg" ContentType="image/svg+xml"/>
  <Default Extension="css" ContentType="text/css"/>
  <Default Extension="html" ContentType="text/html"/>
  <Default Extension="xml" ContentType="text/xml"/>
  <Default Extension="txt" ContentType="text/plain"/>
</Types>`;

// Créez le fichier extension.vsixmanifest
const vsixManifestTemplate = `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="${packageJson.name}" Version="${packageJson.version}" Publisher="${packageJson.publisher}" />
    <DisplayName>${packageJson.displayName || packageJson.name}</DisplayName>
    <Description xml:space="preserve">${packageJson.description}</Description>
    <Tags>${(packageJson.keywords || []).join(',')}</Tags>
    <Categories>${(packageJson.categories || []).join(',')}</Categories>
    <GalleryFlags>Public</GalleryFlags>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code"/>
  </Installation>
  <Dependencies/>
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/readme.md" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Manifest" Path="extension.vsixmanifest" Addressable="true" />
  </Assets>
</PackageManifest>`;

// Fonction pour ajouter un dossier et son contenu de manière récursive
function addDirectoryToArchive(archive, dirPath, entryPrefix) {
    const files = fs.readdirSync(dirPath, { withFileTypes: true });

    for (const file of files) {
        const fullPath = path.join(dirPath, file.name);
        const entryName = path.join(entryPrefix, file.name);

        if (file.isDirectory()) {
            addDirectoryToArchive(archive, fullPath, entryName);
        } else {
            archive.file(fullPath, { name: `extension/${entryName}` });
        }
    }
}

// Créez le fichier package
const output = fs.createWriteStream(vsixFilename);
const archive = archiver('zip', { zlib: { level: 9 } });

output.on('close', () => {
    console.log(`Extension packagée avec succès : ${vsixFilename}`);
});

archive.on('error', (err) => {
    console.error('Erreur lors du packaging :', err);
    process.exit(1);
});

archive.on('warning', (err) => {
    if (err.code === 'ENOENT') {
        console.warn('Avertissement:', err);
    } else {
        console.error('Erreur:', err);
        process.exit(1);
    }
});

archive.pipe(output);

// Ajoutez le fichier [Content_Types].xml
const contentTypesPath = path.join(projectRoot, '[Content_Types].xml');
fs.writeFileSync(contentTypesPath, contentTypesXml);
archive.file(contentTypesPath, { name: '[Content_Types].xml' });

// Écrivez le manifeste dans le répertoire racine du projet
const manifestPath = path.join(projectRoot, 'extension.vsixmanifest');
fs.writeFileSync(manifestPath, vsixManifestTemplate);
archive.file(manifestPath, { name: 'extension.vsixmanifest' });

// Liste des fichiers individuels à inclure
const filesToInclude = [
    'package.json',
    'readme.md',
    'LICENSE'
];

// Liste des dossiers à inclure
const foldersToInclude = [
    'images',
    'dist',
    'syntaxes'
];

// Ajoutez les fichiers individuels
filesToInclude.forEach(file => {
    const filePath = path.join(projectRoot, file);
    if (fs.existsSync(filePath) && fs.lstatSync(filePath).isFile()) {
        archive.file(filePath, { name: `extension/${file}` });
    } else {
        console.warn(`Avertissement: Le fichier '${file}' n'existe pas ou n'est pas un fichier.`);
    }
});

// Ajoutez les dossiers et leur contenu
foldersToInclude.forEach(folder => {
    const folderPath = path.join(projectRoot, folder);
    if (fs.existsSync(folderPath) && fs.lstatSync(folderPath).isDirectory()) {
        addDirectoryToArchive(archive, folderPath, folder);
    } else {
        console.warn(`Avertissement: Le dossier '${folder}' n'existe pas ou n'est pas un répertoire.`);
    }
});

// Nettoyage des fichiers temporaires après finalisation
archive.finalize().then(() => {
    // Supprimer les fichiers temporaires
    try {
        fs.unlinkSync(contentTypesPath);
        fs.unlinkSync(manifestPath);
        console.log('Fichiers temporaires nettoyés.');
    } catch (err) {
        console.warn('Avertissement lors du nettoyage des fichiers temporaires:', err);
    }
}).catch(err => {
    console.error('Erreur lors de la finalisation:', err);
});
