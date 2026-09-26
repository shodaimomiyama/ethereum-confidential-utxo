// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

interface IRouterConfiguration {
    function factory() external view returns (address);
    function WETH() external view returns (address);
}

interface IFactoryConfiguration {
    function getPair(address tokenA, address tokenB) external view returns (address);
}

interface IPairConfiguration {
    function factory() external view returns (address);
    function token0() external view returns (address);
    function token1() external view returns (address);
}

contract UniswapPaymentAdapter {
    error InvalidConfiguration();

    struct PaymentTerms {
        bytes32 operationId;
        address owner;
        uint256 ethAmount;
        address token;
        uint256 minAmountOut;
        address recipient;
        uint64 deadline;
    }

    address public immutable pool;
    address public immutable router02;
    address public immutable factory;
    address public immutable weth;
    address public immutable dUSD;
    address public immutable pair;

    constructor(address pool_, address router02_, address factory_, address weth_, address dUSD_, address pair_) {
        if (
            pool_.code.length == 0 || router02_.code.length == 0 || factory_.code.length == 0 || weth_.code.length == 0
                || dUSD_.code.length == 0 || pair_.code.length == 0
        ) revert InvalidConfiguration();

        address first = weth_ < dUSD_ ? weth_ : dUSD_;
        address second = weth_ < dUSD_ ? dUSD_ : weth_;
        if (
            IRouterConfiguration(router02_).factory() != factory_ || IRouterConfiguration(router02_).WETH() != weth_
                || IFactoryConfiguration(factory_).getPair(weth_, dUSD_) != pair_
                || IPairConfiguration(pair_).factory() != factory_ || IPairConfiguration(pair_).token0() != first
                || IPairConfiguration(pair_).token1() != second
        ) revert InvalidConfiguration();

        pool = pool_;
        router02 = router02_;
        factory = factory_;
        weth = weth_;
        dUSD = dUSD_;
        pair = pair_;
    }
}
