require("dotenv").config();
const express = require("express");
const multer = require("multer");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const FormData = require("form-data");
const {
  Connection,
  PublicKey,
  Keypair,
  Transaction,
  SystemProgram,
  clusterApiUrl,
} = require("@solana/web3.js");
const {
  createInitializeMintInstruction,
  getMinimumBalanceForRentExemptMint,
  MINT_SIZE,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
} = require("@solana/spl-token");
const {
  PROGRAM_ID: METADATA_PROGRAM_ID,
  createCreateMetadataAccountV3Instruction,
} = require("@metaplex-foundation/mpl-token-metadata");

const PINATA_API_KEY = process.env.PINATA_API_KEY;
const PINATA_SECRET_API_KEY = process.env.PINATA_SECRET_API_KEY;

const app = express();
const port = 3001;

app.use(cors());
app.use(express.json());

const frontendPath = path.resolve(__dirname, "frontend");
app.use(express.static(frontendPath));
app.get("/", (req, res) => {
  res.sendFile(path.join(frontendPath, "index.html"));
});

const upload = multer({
  dest: "uploads/",
  fileFilter: (req, file, cb) => {
    const allowedMimeTypes = ["image/png", "image/jpeg", "image/webp"];
    if (!allowedMimeTypes.includes(file.mimetype)) {
      return cb(new Error("허용되지 않는 이미지 형식입니다."));
    }
    cb(null, true);
  },
});

const connection = new Connection(clusterApiUrl("mainnet-beta"), "confirmed");
const FEE_WALLET = new PublicKey("AS1Zz2Hs2Rk35XPVPwpaUHtEANTEe9DKsC8yHQNjR6Gi");

async function uploadToIPFS(filePath, fileName) {
  try {
    const data = new FormData();
    data.append("file", fs.createReadStream(filePath), fileName);

    const res = await axios.post("https://api.pinata.cloud/pinning/pinFileToIPFS", data, {
      maxBodyLength: Infinity,
      headers: {
        "Content-Type": `multipart/form-data; boundary=${data._boundary}`,
        pinata_api_key: PINATA_API_KEY,
        pinata_secret_api_key: PINATA_SECRET_API_KEY,
      },
    });

    fs.unlink(filePath, (err) => {
      if (err) console.error("파일 삭제 실패:", err.message);
      else console.log("✔ 업로드된 로컬 이미지 파일 삭제 완료");
    });

    return `https://gateway.pinata.cloud/ipfs/${res.data.IpfsHash}`;
  } catch (err) {
    console.error("❌ 이미지 업로드 실패:", err.response?.data || err.message);
    throw err;
  }
}

async function uploadMetadataToIPFS(metadata) {
  const res = await axios.post("https://api.pinata.cloud/pinning/pinJSONToIPFS", metadata, {
    headers: {
      pinata_api_key: PINATA_API_KEY,
      pinata_secret_api_key: PINATA_SECRET_API_KEY,
    },
  });
  return `https://gateway.pinata.cloud/ipfs/${res.data.IpfsHash}`;
}

app.post("/mint", upload.single("image"), async (req, res) => {
  try {
    const { name, symbol, amount, user } = req.body;
    const imageFile = req.file;

    if (!name || !symbol || !amount || !imageFile || !user)
      return res.status(400).json({ message: "모든 필드를 입력해주세요." });
    if (name.length > 32 || symbol.length > 10)
      return res.status(400).json({ message: "이름은 32자, 심볼은 10자 이하로 입력해주세요." });

    const imageURL = await uploadToIPFS(imageFile.path, imageFile.originalname);
    const metadata = {
      name,
      symbol,
      description: `${name} - Created via BBANG Token Minter`,
      image: imageURL,
    };
    const metadataURL = await uploadMetadataToIPFS(metadata);

    const userPubkey = new PublicKey(user);
    const mint = Keypair.generate();
    const lamports = await getMinimumBalanceForRentExemptMint(connection);
    const tokenATA = await getAssociatedTokenAddress(mint.publicKey, userPubkey);

    const tx = new Transaction();

    tx.add(SystemProgram.createAccount({
      fromPubkey: userPubkey,
      newAccountPubkey: mint.publicKey,
      space: MINT_SIZE,
      lamports,
      programId: require("@solana/spl-token").TOKEN_PROGRAM_ID,
    }));

    tx.add(createInitializeMintInstruction(mint.publicKey, 0, userPubkey, userPubkey));
    tx.add(createAssociatedTokenAccountInstruction(userPubkey, tokenATA, userPubkey, mint.publicKey));
    tx.add(createMintToInstruction(mint.publicKey, tokenATA, userPubkey, parseInt(amount)));
    const [metadataPDA] = await PublicKey.findProgramAddress(
  [
    Buffer.from("metadata"),
    METADATA_PROGRAM_ID.toBuffer(),
    mint.publicKey.toBuffer(),
  ],
  METADATA_PROGRAM_ID
);

const metadataIx = createCreateMetadataAccountV3Instruction(
  {
    metadata: metadataPDA,
    mint: mint.publicKey,
    mintAuthority: userPubkey,
    payer: userPubkey,
    updateAuthority: userPubkey,
  },
  {
    createMetadataAccountArgsV3: {
      data: {
        name,
        symbol,
        uri: metadataURL,
        sellerFeeBasisPoints: 0,
        creators: null,
        collection: null,
        uses: null,
      },
      isMutable: false,
      collectionDetails: null,
    },
  }
);

tx.add(metadataIx);

    console.log("🪙 생성된 Mint 주소:", mint.publicKey.toBase58());
    tx.feePayer = userPubkey;
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    tx.partialSign(mint);

    const serialized = tx.serialize({ requireAllSignatures: false });
    return res.json({
      message: "트랜잭션 생성 완료. Phantom으로 서명 진행하세요.",
      tx: serialized.toString("base64"),
      metadataURI: metadataURL,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: "서버 오류" });
  }
});

app.get("/owned-tokens", async (req, res) => {
  const wallet = req.query.wallet;
  if (!wallet) return res.status(400).json({ message: "지갑 주소가 없습니다." });

  try {
    const owner = new PublicKey(wallet);
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(owner, {
      programId: require("@solana/spl-token").TOKEN_PROGRAM_ID,
    });
    const mintAddresses = tokenAccounts.value
      .filter(acc => acc.account.data.parsed.info.tokenAmount.uiAmount > 0)
      .map(acc => acc.account.data.parsed.info.mint);

    res.json(mintAddresses);
  } catch (err) {
    console.error("토큰 목록 조회 실패:", err);
    res.status(500).json({ message: "토큰 목록 조회 실패" });
  }
});

app.listen(port, () => {
  console.log(`Server ready at http://localhost:${port}`);
});
