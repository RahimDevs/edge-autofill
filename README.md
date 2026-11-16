 # Edge Autofill

 A browser extension for automatically filling supported web forms in Microsoft Edge.

 ## Features

 - Autofill supported form fields quickly.
 - Works from the browser extension interface.
 - Keeps user data local to the browser unless the implementation explicitly configures otherwise.

 ## Installation

 1. Open `edge://extensions` in Microsoft Edge.
 2. Enable **Developer mode**.
 3. Select **Load unpacked**.
 4. Choose this project directory.
 5. Pin the extension and open a supported form to test it.

 ## Development

 Clone the repository and open the project directory:

 ```bash
 git clone <repository-url>
 cd edge-autofill
 ```

 Load the directory as an unpacked extension. After changing extension files, select **Reload** on the extension card in `edge://extensions`.

 ## Usage

 1. Open a page containing a supported form.
 2. Select the Edge Autofill extension.
 3. Choose the available autofill action.
 4. Review the inserted values before submitting the form.

 ## Privacy and security

 Autofilled information may contain sensitive personal data. Use the extension only on trusted pages, review values before submission, and do not commit credentials or personal information to this repository.

 ## Contributing

 Create a focused change, test it in Microsoft Edge, and submit a pull request describing the behavior that was changed.

 ## License

 No license has been specified yet.
