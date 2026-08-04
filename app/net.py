import ssl

import certifi

SSL_CONTEXT = ssl.create_default_context(cafile=certifi.where())
