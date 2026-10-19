// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title CreditRegistry ("Proof of Wealth")
/// @notice Stores privacy-preserving attestations about a subject's OFF-chain wealth:
///         only a tier, a score and a capped credit line go on-chain, never balances.
///         `sourcesRoot` commits to the underlying bank/broker evidence (in production: zkTLS proofs).
///         Each credit line can be pledged to exactly one lending pool at a time (no double-pledging).
contract CreditRegistry {
    struct Attestation {
        uint8 tier;
        uint16 score;
        uint64 issuedAt;
        uint64 expiresAt;
        uint256 creditLineUsd6;
        bytes32 sourcesRoot;
    }

    bytes32 public constant ATTESTATION_TYPEHASH = keccak256(
        "Attestation(address subject,uint8 tier,uint16 score,uint256 creditLineUsd6,uint64 expiresAt,bytes32 sourcesRoot,uint256 nonce)"
    );
    bytes32 public immutable DOMAIN_SEPARATOR;

    address public owner;
    address public attestor;

    mapping(address => Attestation) public attestations;
    mapping(address => uint256) public nonces;
    mapping(address => bool) public isPool;
    mapping(address => address) public pledgedTo;

    event AttestationPublished(
        address indexed subject, uint8 tier, uint16 score, uint256 creditLineUsd6, uint64 expiresAt, bytes32 sourcesRoot
    );
    event CreditPledged(address indexed subject, address indexed pool);
    event CreditReleased(address indexed subject, address indexed pool);

    modifier onlyOwner() {
        require(msg.sender == owner, "only owner");
        _;
    }

    constructor(address _attestor) {
        owner = msg.sender;
        attestor = _attestor;
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("HaloCreditRegistry")),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );
    }

    function setPool(address pool, bool allowed) external onlyOwner {
        isPool[pool] = allowed;
    }

    function setAttestor(address newAttestor) external onlyOwner {
        attestor = newAttestor;
    }

    function publish(
        address subject,
        uint8 tier,
        uint16 score,
        uint256 creditLineUsd6,
        uint64 expiresAt,
        bytes32 sourcesRoot,
        bytes calldata signature
    ) external {
        require(expiresAt > block.timestamp, "attestation expired");
        require(tier <= 3, "bad tier");
        bytes32 structHash = keccak256(
            abi.encode(ATTESTATION_TYPEHASH, subject, tier, score, creditLineUsd6, expiresAt, sourcesRoot, nonces[subject])
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
        require(_recover(digest, signature) == attestor, "bad attestor signature");

        nonces[subject]++;
        attestations[subject] =
            Attestation(tier, score, uint64(block.timestamp), expiresAt, creditLineUsd6, sourcesRoot);
        emit AttestationPublished(subject, tier, score, creditLineUsd6, expiresAt, sourcesRoot);
    }

    /// @notice Tier and credit line, or zeros once the attestation has expired.
    function activeCredit(address subject) public view returns (uint8 tier, uint256 creditLineUsd6, uint64 expiresAt) {
        Attestation memory a = attestations[subject];
        if (a.expiresAt <= block.timestamp) return (0, 0, a.expiresAt);
        return (a.tier, a.creditLineUsd6, a.expiresAt);
    }

    function pledge(address subject) external {
        require(isPool[msg.sender], "not a pool");
        address current = pledgedTo[subject];
        require(current == address(0) || current == msg.sender, "credit already pledged elsewhere");
        pledgedTo[subject] = msg.sender;
        emit CreditPledged(subject, msg.sender);
    }

    function release(address subject) external {
        require(pledgedTo[subject] == msg.sender, "not pledged to caller");
        pledgedTo[subject] = address(0);
        emit CreditReleased(subject, msg.sender);
    }

    function _recover(bytes32 digest, bytes calldata sig) internal pure returns (address signer) {
        require(sig.length == 65, "bad signature length");
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        if (v < 27) v += 27;
        require(uint256(s) <= 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0, "bad s");
        signer = ecrecover(digest, v, r, s);
        require(signer != address(0), "bad signature");
    }
}
