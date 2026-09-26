// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {UniswapPaymentAdapter} from "../../../src/integration/uniswap/UniswapPaymentAdapter.sol";

contract ConfigCode {}

contract ConfigRouter {
    address public factory;
    address public WETH;

    constructor(address fixedFactory, address fixedWeth) {
        factory = fixedFactory;
        WETH = fixedWeth;
    }

    function setFactory(address value) external {
        factory = value;
    }

    function setWeth(address value) external {
        WETH = value;
    }
}

contract ConfigFactory {
    address public pair;

    constructor(address fixedPair) {
        pair = fixedPair;
    }

    function getPair(address, address) external view returns (address) {
        return pair;
    }

    function setPair(address value) external {
        pair = value;
    }
}

contract ConfigPair {
    address public factory;
    address public token0;
    address public token1;

    constructor(address fixedFactory, address first, address second) {
        factory = fixedFactory;
        token0 = first;
        token1 = second;
    }

    function setFactory(address value) external {
        factory = value;
    }

    function setToken0(address value) external {
        token0 = value;
    }

    function setToken1(address value) external {
        token1 = value;
    }
}

contract AdapterConfigurationTest {
    function _deploy()
        private
        returns (
            ConfigCode pool,
            ConfigRouter router,
            ConfigFactory factory,
            ConfigCode weth,
            ConfigCode dusd,
            ConfigPair pair
        )
    {
        pool = new ConfigCode();
        weth = new ConfigCode();
        dusd = new ConfigCode();
        factory = new ConfigFactory(address(0));
        (address first, address second) =
            address(weth) < address(dusd) ? (address(weth), address(dusd)) : (address(dusd), address(weth));
        pair = new ConfigPair(address(factory), first, second);
        factory.setPair(address(pair));
        router = new ConfigRouter(address(factory), address(weth));
    }

    function _create(address pool, address router, address factory, address weth, address dusd, address pair)
        private
        returns (UniswapPaymentAdapter)
    {
        return new UniswapPaymentAdapter(pool, router, factory, weth, dusd, pair);
    }

    function _rejected(address pool, address router, address factory, address weth, address dusd, address pair)
        private
        returns (bool)
    {
        try this.construct(pool, router, factory, weth, dusd, pair) returns (UniswapPaymentAdapter) {
            return false;
        } catch {
            return true;
        }
    }

    function construct(address pool, address router, address factory, address weth, address dusd, address pair)
        external
        returns (UniswapPaymentAdapter)
    {
        return _create(pool, router, factory, weth, dusd, pair);
    }

    function test_fixedConfigurationIsReadable() public {
        (
            ConfigCode pool,
            ConfigRouter router,
            ConfigFactory factory,
            ConfigCode weth,
            ConfigCode dusd,
            ConfigPair pair
        ) = _deploy();
        UniswapPaymentAdapter adapter =
            _create(address(pool), address(router), address(factory), address(weth), address(dusd), address(pair));
        require(adapter.pool() == address(pool), "pool changed");
        require(adapter.router02() == address(router), "router changed");
        require(adapter.factory() == address(factory), "factory changed");
        require(adapter.weth() == address(weth), "weth changed");
        require(adapter.dUSD() == address(dusd), "dusd changed");
        require(adapter.pair() == address(pair), "pair changed");
    }

    function test_rejectsZeroAndMissingCode() public {
        (
            ConfigCode pool,
            ConfigRouter router,
            ConfigFactory factory,
            ConfigCode weth,
            ConfigCode dusd,
            ConfigPair pair
        ) = _deploy();
        address[6] memory values =
            [address(pool), address(router), address(factory), address(weth), address(dusd), address(pair)];
        for (uint256 i; i < values.length; ++i) {
            address saved = values[i];
            values[i] = address(0);
            require(_rejected(values[0], values[1], values[2], values[3], values[4], values[5]), "zero accepted");
            values[i] = address(0xBEEF);
            require(_rejected(values[0], values[1], values[2], values[3], values[4], values[5]), "no code accepted");
            values[i] = saved;
        }
    }

    function test_rejectsWrongReferences() public {
        (
            ConfigCode pool,
            ConfigRouter router,
            ConfigFactory factory,
            ConfigCode weth,
            ConfigCode dusd,
            ConfigPair pair
        ) = _deploy();
        address[6] memory values =
            [address(pool), address(router), address(factory), address(weth), address(dusd), address(pair)];
        router.setFactory(address(0xBEEF));
        require(_rejected(values[0], values[1], values[2], values[3], values[4], values[5]), "wrong router factory");
        router.setFactory(address(factory));
        router.setWeth(address(0xBEEF));
        require(_rejected(values[0], values[1], values[2], values[3], values[4], values[5]), "wrong router WETH");
        router.setWeth(address(weth));
        factory.setPair(address(0xBEEF));
        require(_rejected(values[0], values[1], values[2], values[3], values[4], values[5]), "wrong factory pair");
        factory.setPair(address(pair));
        pair.setFactory(address(0xBEEF));
        require(_rejected(values[0], values[1], values[2], values[3], values[4], values[5]), "wrong pair factory");
        pair.setFactory(address(factory));
        pair.setToken0(address(0xBEEF));
        require(_rejected(values[0], values[1], values[2], values[3], values[4], values[5]), "wrong token0");
    }
}
